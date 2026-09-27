/** Exact, offline Merkle commitments for unpublished Launchpad airdrops.
 * This module prepares data only; it never infers that a realm is deployed.
 */
import { sha256 } from "@noble/hashes/sha2.js"
import { isValidGnoAddressChecksum } from "./dao/address"
import { bech32Encode } from "./dao/realmAddress"

const MAX_INT64 = 9223372036854775807n
const MAX_ENTRIES = 100_000
const SALES_PATH = "gno.land/r/samcrew/launchpad/sales/v1"
const encoder = new TextEncoder()
const SALES_ADDRESS = bech32Encode("g", sha256(encoder.encode(`pkgPath:${SALES_PATH}`)).slice(0, 20))

export interface AirdropManifestEntry {
    index: number
    beneficiary: string
    /** Canonical unsigned int64 decimal string in token base units. */
    amount: string
}

export interface AirdropManifestClaim extends AirdropManifestEntry {
    /** Canonical comma-separated lowercase sibling hashes, or empty for one leaf. */
    proof: string
}

export interface PreparedAirdropManifest {
    tokenId: string
    root: string
    fundedTotal: string
    allocatedTotal: string
    /** Funded tokens with no leaf entitlement; policy must decide their fate. */
    unallocated: string
    claims: AirdropManifestClaim[]
}

function fail(message: string): never {
    throw new Error(`Launchpad airdrop manifest: ${message}`)
}

function parseAmount(raw: string, allowZero = false): bigint {
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw)) fail("amount must be a canonical decimal string")
    const amount = BigInt(raw)
    if ((!allowZero && amount === 0n) || amount > MAX_INT64) fail("amount is outside positive int64 range")
    return amount
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return a[i] - b[i]
    }
    return 0
}

function node(a: Uint8Array, b: Uint8Array): Uint8Array {
    const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a]
    const bytes = new Uint8Array(65)
    bytes[0] = 1
    bytes.set(first, 1)
    bytes.set(second, 33)
    return sha256(bytes)
}

function leaf(tokenId: string, entry: AirdropManifestEntry): Uint8Array {
    const data = encoder.encode(`launchpad-airdrop-v1|${tokenId}|${entry.index}|${entry.beneficiary}|${entry.amount}`)
    const bytes = new Uint8Array(data.length + 1)
    bytes.set(data, 1) // Merkle Leaf prefixes 0x00.
    return sha256(bytes)
}

/** Mirrors Gno p/merkle/v1: sorted SHA-256 pairs and unmodified odd promotion. */
export function prepareAirdropManifest(
    tokenId: string,
    fundedTotal: string,
    input: readonly AirdropManifestEntry[],
): PreparedAirdropManifest {
    if (!/^T[1-9][0-9]{0,9}$/.test(tokenId)) fail("invalid token ID")
    const funded = parseAmount(fundedTotal)
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ENTRIES) fail("invalid entry count")

    const entries = input.map(entry => {
        if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.index) || entry.index < 0) fail("invalid leaf index")
        if (!isValidGnoAddressChecksum(entry.beneficiary) || entry.beneficiary === SALES_ADDRESS) fail("invalid beneficiary")
        parseAmount(entry.amount)
        return { index: entry.index, beneficiary: entry.beneficiary, amount: entry.amount }
    }).sort((a, b) => a.index - b.index)

    let allocated = 0n
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].index !== i) fail("indices must be unique and contiguous from zero")
        allocated += BigInt(entries[i].amount)
        if (allocated > funded) fail("leaf amounts exceed funded total")
    }

    const levels: Uint8Array[][] = [entries.map(entry => leaf(tokenId, entry))]
    while (levels[levels.length - 1].length > 1) {
        const previous = levels[levels.length - 1]
        const next: Uint8Array[] = []
        for (let i = 0; i < previous.length; i += 2) {
            next.push(i + 1 < previous.length ? node(previous[i], previous[i + 1]) : previous[i])
        }
        levels.push(next)
    }

    const claims = entries.map((entry, index) => {
        const siblings: string[] = []
        let offset = index
        for (let level = 0; level < levels.length - 1; level++) {
            const sibling = offset ^ 1
            if (sibling < levels[level].length) siblings.push(toHex(levels[level][sibling]))
            offset = Math.floor(offset / 2)
        }
        return { ...entry, proof: siblings.join(",") }
    })

    return {
        tokenId,
        root: toHex(levels[levels.length - 1][0]),
        fundedTotal,
        allocatedTotal: allocated.toString(),
        unallocated: (funded - allocated).toString(),
        claims,
    }
}

/** Rebuilds a published manifest against a root and total read from chain. */
export function verifyAirdropManifest(
    manifest: PreparedAirdropManifest,
    commitment: { tokenId: string; root: string; total: string },
): PreparedAirdropManifest {
    if (!manifest || typeof manifest !== "object" || !commitment || typeof commitment !== "object" ||
        !/^[0-9a-f]{64}$/.test(manifest.root) || !/^[0-9a-f]{64}$/.test(commitment.root)) fail("invalid root")
    if (manifest.tokenId !== commitment.tokenId || manifest.root !== commitment.root ||
        manifest.fundedTotal !== commitment.total) fail("manifest does not match chain commitment")
    const rebuilt = prepareAirdropManifest(manifest.tokenId, manifest.fundedTotal, manifest.claims)
    if (rebuilt.root !== manifest.root || rebuilt.allocatedTotal !== manifest.allocatedTotal ||
        rebuilt.unallocated !== manifest.unallocated || rebuilt.claims.length !== manifest.claims.length ||
        rebuilt.claims.some((claim, i) => claim.proof !== manifest.claims[i].proof)) {
        fail("manifest does not match root, totals or proofs")
    }
    return rebuilt
}

/** Verify public curation evidence bytes before rendering untrusted IPFS text. */
import type { Token } from "../gen/memba/v1/memba_pb"
import { API_BASE_URL } from "./config"
import { walletBearer } from "./walletBearer"
const CID = /^(bafy[a-z2-7]{55,86}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/
const HASH = /^[0-9a-f]{64}$/
const MAX_BYTES = 16 * 1024
const GATEWAYS = ["https://gateway.lighthouse.storage/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"]

export interface VerifiedCurationEvidence { cid: string; sha256: string; text: string }

export async function uploadCurationEvidence(collection: string, account: string, chainId: string,
    token: Token, text: string, signal?: AbortSignal): Promise<VerifiedCurationEvidence> {
    const bytes = new TextEncoder().encode(text)
    if (!/^C[1-9][0-9]{0,17}$/.test(collection) || !text.trim() || bytes.length > MAX_BYTES || text.includes("\0")) {
        throw new Error("Write public evidence of up to 16 KiB for a valid collection.")
    }
    if (!account || token.userAddress !== account || token.chainId !== chainId) {
        throw new Error("Sign in with the wallet on this network before publishing evidence.")
    }
    const query = new URLSearchParams({ collection })
    const response = await fetch(`${API_BASE_URL || ""}/api/nft/curation-evidence/upload?${query}`, {
        method: "POST", headers: { Authorization: walletBearer(token), "Content-Type": "text/plain; charset=utf-8" },
        body: text, cache: "no-store", signal,
    })
    if (!response.ok) throw new Error(response.status === 403 ? "This wallet is not eligible to publish evidence for the collection." :
        response.status === 429 ? "Evidence upload limit reached. Wait and try again." :
            response.status === 503 ? "Public evidence upload is not available yet." : "Could not pin public evidence.")
    const raw: unknown = await response.json()
    if (!raw || typeof raw !== "object") throw new Error("Invalid evidence pin response.")
    const pinned = raw as Record<string, unknown>
    if (typeof pinned.cid !== "string" || !CID.test(pinned.cid) || typeof pinned.sha256 !== "string" || !HASH.test(pinned.sha256)) {
        throw new Error("Invalid evidence pin response.")
    }
    const localHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)),
        (byte) => byte.toString(16).padStart(2, "0")).join("")
    if (localHash !== pinned.sha256) throw new Error("Pinned evidence hash does not match your text.")
    const verified = await fetchCurationEvidence(pinned.cid, pinned.sha256, signal)
    if (verified.text !== text) throw new Error("Pinned evidence text changed. Review it before signing.")
    return verified
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
    if (!response.ok || !response.body) throw new Error("Public evidence is unavailable.")
    const declared = response.headers.get("Content-Length")
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error("Public evidence is too large.")
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let total = 0
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_BYTES) throw new Error("Public evidence is too large.")
            parts.push(value)
        }
    } finally { await reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
    return bytes
}

/** CID is treated only as an address. The SHA-256 in the chain record is the
 * integrity check, so a wrong or unavailable gateway never produces text. */
export async function fetchCurationEvidence(cid: string, sha256: string, signal?: AbortSignal): Promise<VerifiedCurationEvidence> {
    if (!CID.test(cid) || !HASH.test(sha256)) throw new Error("Invalid public evidence commitment.")
    for (const gateway of GATEWAYS) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
        const controller = new AbortController()
        const onAbort = () => controller.abort()
        signal?.addEventListener("abort", onAbort, { once: true })
        const timer = setTimeout(() => controller.abort(), 8000)
        try {
            const response = await fetch(gateway + cid, { signal: controller.signal, cache: "no-store", redirect: "error" })
            const bytes = await boundedBytes(response)
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer)), (byte) => byte.toString(16).padStart(2, "0")).join("")
            if (digest !== sha256) throw new Error("Public evidence bytes do not match the on-chain hash.")
            const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            if (!text.trim() || text.includes("\0")) throw new Error("Public evidence is not readable text.")
            return { cid, sha256, text }
        } catch (cause) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
            if (cause instanceof Error && cause.message.includes("do not match")) throw cause
            // A gateway may be offline or lack CORS. Try another approved gateway.
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener("abort", onAbort)
        }
    }
    throw new Error("Public evidence is unavailable from the configured gateways.")
}

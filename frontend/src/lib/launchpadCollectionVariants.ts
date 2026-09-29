/** Native-fee collection creation with permanent royalty and reveal commitments. */
import { clearGovernanceReceipt } from "./dao/governanceRecovery"
import { isValidGnoAddressChecksum } from "./dao/address"
import { packageAddress } from "./dao/weightedApplications"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { readActionTerms, type LaunchpadActionTerms } from "./launchpadActionTerms"
import { buildCreateCollectionMsg, CREATE_COLLECTION_GAS_WANTED, createCollectionScope, readCollectionCount,
    sameCollectionTerms, validateStaticCollection, type StaticCollectionDraft } from "./launchpadCollectionCreate"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_DROPS_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const HASH = /^[0-9a-f]{64}$/
const BAD_URI_CHARS = "\"'<>\\`()[]{}|^"
const STORAGE_CAP = 10_000_000
const FORBIDDEN_RECEIVERS = new Set([LAUNCHPAD_DROPS_PATH, LAUNCHPAD_FEES_PATH, LAUNCHPAD_MARKET_PATH, LAUNCHPAD_NFT_PATH]
    .map(packageAddress))

export interface CollectionRoyaltyInput { account: string; bps: bigint }
type Core = Omit<StaticCollectionDraft, "baseURI">
export type CollectionCreationDraft =
    | (Core & { metadataMode: "static"; baseURI: string; royalties: CollectionRoyaltyInput[] })
    | (Core & { metadataMode: "reveal"; placeholderURI: string; committedBaseURIHash: string;
        provenanceHash: string; royalties: CollectionRoyaltyInput[] })

function safeURIChars(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code <= 0x20 || code >= 0x7f || BAD_URI_CHARS.includes(text[i])) return false
    }
    return true
}

export function encodeCollectionRoyalties(draft: CollectionCreationDraft): { encoded: string; ordered: CollectionRoyaltyInput[]; totalBPS: bigint } {
    const ordered = [...draft.royalties].sort((a, b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0)
    if (ordered.length > 10 || (draft.mode === "soulbound" && ordered.length > 0)) throw new Error("Soulbound collections cannot have royalties; Open collections support up to ten receivers.")
    let totalBPS = 0n
    for (let index = 0; index < ordered.length; index++) {
        const receiver = ordered[index]
        if (!isValidGnoAddressChecksum(receiver.account) || FORBIDDEN_RECEIVERS.has(receiver.account) ||
            (index > 0 && receiver.account === ordered[index - 1].account) ||
            receiver.bps < 1n || receiver.bps > 1000n) throw new Error("Check each royalty receiver and basis-point share.")
        totalBPS += receiver.bps
    }
    if (totalBPS > 1000n) throw new Error("Creator royalties cannot exceed 10% in total.")
    const encoded = ordered.map((receiver) => `${receiver.account}:${receiver.bps.toString()}`).join(";")
    if (encoded.length > 1024) throw new Error("Royalty terms are too long.")
    return { encoded, ordered, totalBPS }
}

export function validateCreationDraft(draft: CollectionCreationDraft): void {
    if (draft.metadataMode !== "static" && draft.metadataMode !== "reveal") throw new Error("Choose a supported metadata mode.")
    validateStaticCollection({ ...draft, baseURI: draft.metadataMode === "static" ? draft.baseURI : "ipfs://pending/" })
    if (draft.metadataMode === "reveal" &&
        (draft.placeholderURI.length < 15 || draft.placeholderURI.length > 200 ||
            !draft.placeholderURI.startsWith("ipfs://") || !draft.placeholderURI.endsWith(".json") ||
            !safeURIChars(draft.placeholderURI) || !HASH.test(draft.committedBaseURIHash) ||
            !HASH.test(draft.provenanceHash))) throw new Error("Check the IPFS placeholder and both lowercase SHA-256 commitments.")
    encodeCollectionRoyalties(draft)
}

export function buildCreateCollectionVariantMsg(draft: CollectionCreationDraft, terms: LaunchpadActionTerms): AminoMsg {
    validateCreationDraft(draft)
    const { encoded } = encodeCollectionRoyalties(draft)
    const base = buildCreateCollectionMsg({ ...draft, baseURI: draft.metadataMode === "static" ? draft.baseURI : "ipfs://pending/" }, terms)
    if (draft.metadataMode === "static" && encoded === "") return base
    const baseArgs = base.value.args
    if (!Array.isArray(baseArgs) || baseArgs.length !== 12 || baseArgs.some((arg) => typeof arg !== "string")) throw new Error("Invalid collection creation call")
    const args: string[] = baseArgs.slice(0, 9)
    const func = draft.metadataMode === "static" ? "CreateCollectionWithRoyalties" :
        encoded === "" ? "CreateCollectionWithReveal" : "CreateCollectionWithRevealAndRoyalties"
    if (draft.metadataMode === "static") args.push(draft.baseURI)
    else args.push(draft.placeholderURI, draft.committedBaseURIHash, draft.provenanceHash)
    if (encoded !== "") args.push(encoded)
    args.push("ugnot", terms.version.toString())
    return { ...base, value: { ...base.value, func, args } }
}

function matchesCreated(draft: CollectionCreationDraft, terms: LaunchpadActionTerms,
    created: LaunchpadNftCollection, ordered: CollectionRoyaltyInput[], totalBPS: bigint): boolean {
    const sameCore = created.creator === draft.creator && created.name === draft.name && created.symbol === draft.symbol &&
        created.description === draft.description && created.image === draft.image && created.banner === draft.banner &&
        created.website === draft.website && created.mode === draft.mode && created.revocable === draft.revocable &&
        created.maxSupply === draft.maxSupply && created.configVersion === terms.version &&
        created.minted === 0n && created.totalSupply === 0n && created.royaltyBPS === totalBPS &&
        created.royalties.length === ordered.length && created.royalties.every((receiver, index) =>
            receiver.account === ordered[index].account && receiver.bps === ordered[index].bps)
    if (!sameCore) return false
    return draft.metadataMode === "static" ?
        created.metadataMode === "static_base" && created.baseURI === draft.baseURI && created.revealed && created.metadataFrozen :
        created.metadataMode === "reveal_base" && created.baseURI === "" && !created.revealed && !created.metadataFrozen &&
        created.placeholderURI === draft.placeholderURI && created.baseURICommitment === draft.committedBaseURIHash &&
        created.provenanceHash === draft.provenanceHash
}

export function createCollectionVariantRequest(input: {
    draft: CollectionCreationDraft; terms: LaunchpadActionTerms; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { draft, terms, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildCreateCollectionVariantMsg(draft, terms)
    const { ordered, totalBPS } = encodeCollectionRoyalties(draft)
    const scope = createCollectionScope(chainId, draft.creator)
    const label = `Create ${draft.name} collection`
    let baselineCount: bigint | null = null
    return {
        title: "Create Launchpad collection", summary: `${draft.name} (${draft.symbol}) · ${draft.mode}`,
        lines: () => [["Creator", draft.creator], ["Collection", `${draft.name} (${draft.symbol})`],
            ["Transfer mode", draft.mode === "soulbound" ? "Soulbound · transfers and approvals blocked" : "Open · transferable"],
            ["Creator may revoke", draft.revocable ? "Yes, by fixed collection policy" : "No"],
            ["Maximum supply", draft.maxSupply === 0n ? "Uncapped" : draft.maxSupply.toLocaleString()],
            ["Metadata mode", draft.metadataMode === "static" ? "Static · frozen at creation" : "Reveal · committed before mint"],
            ...(draft.metadataMode === "static" ? [["Permanent base URI", draft.baseURI]] as [string, string][] :
                [["Placeholder", draft.placeholderURI], ["Base URI SHA-256", draft.committedBaseURIHash],
                    ["Provenance SHA-256", draft.provenanceHash]] as [string, string][]),
            ["Creator royalty", `${totalBPS.toString()} bps · fixed at creation`],
            ...ordered.map((receiver, index): [string, string] => [`Royalty ${index + 1}`, `${receiver.bps.toString()} bps → ${receiver.account}`]),
            ["DAO collection fee", `${terms.collectionFee.toLocaleString()} ugnot`], ["DAO treasury", terms.treasury],
            ["Policy version", terms.version.toString()], ["Realm", LAUNCHPAD_DROPS_PATH], ["Network", chainId],
            ["Gas limit", CREATE_COLLECTION_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Supply, transfer/revoke rights and creator royalty shares are permanent. A marketplace can pay the recorded royalties; off-market transfers may not.",
            draft.metadataMode === "static" ? "Static metadata freezes at creation. Check its files before signing." :
                "The realm verifies the revealed base URI against its SHA-256 commitment. It does not verify the files or provenance manifest; preserve your exact reveal URI and manifest.",
            ...(draft.mode === "soulbound" ? ["Recipients must claim Soulbound tokens. Do not put sensitive personal claims in public metadata."] : [])],
        acks: ["I checked the permanent collection rights, royalty shares, metadata commitment, DAO fee and chain before opening Adena."],
        label: () => label, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readActionTerms(rpcUrl, "collection", "ugnot")
            if (!sameCollectionTerms(terms, fresh)) throw new Error("DAO collection policy changed. Refresh before signing.")
            buildCreateCollectionVariantMsg(draft, fresh)
            baselineCount = await readCollectionCount(rpcUrl)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: CREATE_COLLECTION_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            if (baselineCount === null || await readCollectionCount(rpcUrl) !== baselineCount + 1n) return false
            const created = await getLaunchpadNftCollection(rpcUrl, `C${(baselineCount + 1n).toString()}`)
            return matchesCreated(draft, terms, created, ordered, totalBPS)
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

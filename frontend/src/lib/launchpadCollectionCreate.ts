/** Reviewed native-fee creation of an Open or Soulbound static Launchpad collection. */
import { queryEval } from "./dao/shared"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { readActionTerms, type LaunchpadActionTerms } from "./launchpadActionTerms"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_DROPS_PATH, LAUNCHPAD_NFT_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const ADDRESS = /^g1[02-9ac-hj-np-z]{38}$/
const MAX_INT64 = 9223372036854775807n
export const CREATE_COLLECTION_GAS_WANTED = 50_000_000
const CREATE_STORAGE_CAP = 10_000_000
const BAD_URI_CHARS = "\"'<>\\`()[]{}|^"

export interface StaticCollectionDraft {
    creator: string
    name: string
    symbol: string
    description: string
    image: string
    banner: string
    website: string
    mode: "open" | "soulbound"
    revocable: boolean
    maxSupply: bigint
    baseURI: string
}

function utf8Length(text: string): number { return new TextEncoder().encode(text).length }
function printable(text: string): boolean { return !/\p{C}/u.test(text) }

function safeURIChars(text: string): boolean {
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code <= 0x20 || code >= 0x7f || BAD_URI_CHARS.includes(text[i])) return false
    }
    return true
}

function mediaURI(text: string): boolean {
    return text === "" || (text.length <= 200 && /^(ipfs:\/\/|https:\/\/).+/.test(text) && safeURIChars(text))
}

export function validateBaseURI(baseURI: string): void {
    if (baseURI.length < 8 || baseURI.length > 200 ||
        !(baseURI.startsWith("ipfs://") || baseURI.startsWith("https://")) ||
        !baseURI.endsWith("/") || !safeURIChars(baseURI)) throw new Error("Enter an IPFS or HTTPS base URI ending in /.")
}

export function validateStaticCollection(draft: StaticCollectionDraft): void {
    if (!ADDRESS.test(draft.creator) || draft.mode !== "open" && draft.mode !== "soulbound" ||
        (draft.revocable && draft.mode !== "soulbound") || draft.maxSupply < 0n || draft.maxSupply > MAX_INT64 ||
        draft.name.trim() !== draft.name || utf8Length(draft.name) < 1 || utf8Length(draft.name) > 32 || !printable(draft.name) ||
        [...draft.name].some((character) => "[]()*#<>`|\\".includes(character)) || !/^([A-Z0-9]){1,10}$/.test(draft.symbol) ||
        utf8Length(draft.description) > 280 || !printable(draft.description) || [...draft.description].some((character) => "[]()<>".includes(character)) ||
        !mediaURI(draft.image) || !mediaURI(draft.banner) ||
        !(draft.website === "" || draft.website.length <= 200 && /^https:\/\/.+/.test(draft.website) && safeURIChars(draft.website))) throw new Error("Check the permanent collection details and metadata URI.")
    validateBaseURI(draft.baseURI)
}

export function validateCollectionTerms(terms: LaunchpadActionTerms): void {
    if (terms.lane !== "collection" || terms.currency !== "ugnot" || !terms.actionReady ||
        terms.collectionFee < 0n || terms.collectionFee > MAX_INT64 || terms.version < 1n || !ADDRESS.test(terms.treasury)) {
        throw new Error("Collection creation is unavailable under the current DAO policy.")
    }
}

export function buildCreateCollectionMsg(draft: StaticCollectionDraft, terms: LaunchpadActionTerms): AminoMsg {
    validateStaticCollection(draft)
    validateCollectionTerms(terms)
    return { type: "vm/MsgCall", value: { caller: draft.creator,
        send: terms.collectionFee === 0n ? "" : `${terms.collectionFee.toString()}ugnot`, pkg_path: LAUNCHPAD_DROPS_PATH,
        func: "CreateCollection", args: [draft.name, draft.symbol, draft.description, draft.image, draft.banner,
            draft.website, draft.mode, String(draft.revocable), draft.maxSupply.toString(), draft.baseURI,
            "ugnot", terms.version.toString()], max_deposit: `${CREATE_STORAGE_CAP}ugnot` } }
}

export function sameCollectionTerms(a: LaunchpadActionTerms, b: LaunchpadActionTerms): boolean {
    return a.lane === b.lane && a.currency === b.currency && a.version === b.version && a.treasury === b.treasury &&
        a.collectionFee === b.collectionFee && a.primaryFeeBPS === b.primaryFeeBPS &&
        a.currencyConfigured === b.currencyConfigured && a.currencyAllowed === b.currencyAllowed &&
        a.paused === b.paused && a.laneReady === b.laneReady && a.actionReady === b.actionReady
}

export async function readCollectionCount(rpcUrl: string): Promise<bigint> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_NFT_PATH, "Count()", true)
    const match = /^\((0|[1-9]\d*) int64\)$/.exec(raw?.trim() ?? "")
    if (!match) throw new Error("Could not verify collection count")
    return BigInt(match[1])
}

export function createCollectionScope(chainId: string, creator: string): GovernanceScope {
    // Keep the original receipt key so a pending static creation still locks every variant.
    return { chainId, realmPath: LAUNCHPAD_DROPS_PATH, caller: creator, operation: "create-static-collection" }
}

export function createStaticCollectionRequest(input: {
    draft: StaticCollectionDraft; terms: LaunchpadActionTerms; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { draft, terms, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildCreateCollectionMsg(draft, terms)
    const scope = createCollectionScope(chainId, draft.creator)
    const label = `Create ${draft.name} collection`
    let baselineCount: bigint | null = null
    return {
        title: "Create Launchpad collection", summary: `${draft.name} (${draft.symbol}) · ${draft.mode}`,
        lines: () => [["Creator", draft.creator], ["Collection", `${draft.name} (${draft.symbol})`],
            ["Transfer mode", draft.mode === "soulbound" ? "Soulbound · transfers and approvals blocked" : "Open · transferable"],
            ["Creator may revoke", draft.revocable ? "Yes, by fixed collection policy" : "No"],
            ["Creator royalties", "None · cannot be added later"],
            ["Maximum supply", draft.maxSupply === 0n ? "Uncapped" : draft.maxSupply.toLocaleString()],
            ["Permanent base URI", draft.baseURI], ["DAO collection fee", `${terms.collectionFee.toLocaleString()} ugnot`],
            ["DAO treasury", terms.treasury], ["Policy version", terms.version.toString()],
            ["Realm", LAUNCHPAD_DROPS_PATH], ["Network", chainId],
            ["Gas limit", CREATE_COLLECTION_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${CREATE_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["The base URI, transfer mode, revocation right, maximum supply and absence of creator royalties are permanent. Static metadata is frozen at creation. Verify the content at the URI before signing.",
            ...(draft.mode === "soulbound" ? ["Recipients must claim Soulbound tokens; holder burn remains available. Do not put sensitive personal claims in public metadata."] : [])],
        acks: ["I checked the collection's permanent terms, DAO fee, metadata URI and chain before opening Adena."],
        label: () => label, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const fresh = await readActionTerms(rpcUrl, "collection", "ugnot")
            if (!sameCollectionTerms(terms, fresh)) throw new Error("DAO collection policy changed. Refresh before signing.")
            buildCreateCollectionMsg(draft, fresh)
            baselineCount = await readCollectionCount(rpcUrl)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: CREATE_COLLECTION_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            if (baselineCount === null || await readCollectionCount(rpcUrl) !== baselineCount + 1n) return false
            const created = await getLaunchpadNftCollection(rpcUrl, `C${(baselineCount + 1n).toString()}`)
            return created.creator === draft.creator && created.name === draft.name && created.symbol === draft.symbol &&
                created.description === draft.description && created.image === draft.image && created.banner === draft.banner &&
                created.website === draft.website && created.mode === draft.mode && created.revocable === draft.revocable &&
                created.maxSupply === draft.maxSupply && created.baseURI === draft.baseURI &&
                created.metadataMode === "static_base" && created.metadataFrozen && created.revealed &&
                created.configVersion === terms.version && created.royaltyBPS === 0n && created.royalties.length === 0 &&
                created.minted === 0n && created.totalSupply === 0n
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

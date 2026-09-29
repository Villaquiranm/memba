/** Reviewed, direct-manager editorial calls. These change placement only, never NFT settlement. */
import type { Token } from "../gen/memba/v1/memba_pb"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getCollectionCuration, getCurationApplication, getCurationEditorialAccess, getCurationState,
    type CurationApplication, type CurationReceipt, type CurationState } from "./launchpadCuration"
import { readCurationEditorialAccess } from "./launchpadCurationInbox"
import { fetchCurationEvidence, type VerifiedCurationEvidence } from "./launchpadCurationEvidence"
import { CURATION_ACTION_GAS_WANTED } from "./launchpadCurationActions"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_CURATION_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

export type EditorialAction = "feature-propose" | "feature-approve" | "hide-start" | "hide-confirm"
const DEPOSIT = 1_000_000
const DAY = 86_400

export function editorialScope(chainId: string, collection: string, caller: string, action: EditorialAction): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_CURATION_PATH, caller, operation: `${action}:${collection}` }
}

export function buildEditorialMsg(action: EditorialAction, collection: string, caller: string,
    evidence?: VerifiedCurationEvidence, until?: string): AminoMsg {
    const spec = action === "feature-propose" ? { func: "ProposeFeature", args: [collection, evidence!.sha256, evidence!.cid, until!] } :
        action === "feature-approve" ? { func: "ApproveFeature", args: [collection] } :
            action === "hide-start" ? { func: "HideTemporarily", args: [collection, evidence!.sha256, evidence!.cid] } :
                { func: "ConfirmHide", args: [collection] }
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_CURATION_PATH,
        ...spec, max_deposit: `${DEPOSIT}ugnot` } }
}

function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function isPending(until: string): boolean { return BigInt(until) > BigInt(Math.floor(Date.now() / 1000)) }

function eligible(action: EditorialAction, receipt: CurationReceipt, caller: string, until?: string): boolean {
    if (action === "feature-propose") return (!receipt.feature || !isPending(receipt.feature.until)) &&
        !!until && /^\d+$/.test(until) && BigInt(until) > BigInt(Math.floor(Date.now() / 1000)) &&
        BigInt(until) <= BigInt(Math.floor(Date.now() / 1000) + 14 * DAY)
    if (action === "feature-approve") return !!receipt.feature && receipt.feature.approver === "" &&
        receipt.feature.proposer !== caller && isPending(receipt.feature.until)
    if (action === "hide-start") return receipt.hold === null
    return !!receipt.hold && receipt.hold.confirmer === "" && receipt.hold.actor !== caller && isPending(receipt.hold.until)
}

function otherActor(action: EditorialAction, receipt: CurationReceipt): string {
    return action === "feature-approve" ? receipt.feature?.proposer ?? "" :
        action === "hide-confirm" ? receipt.hold?.actor ?? "" : ""
}

export function editorialRequest(input: {
    action: EditorialAction; application: CurationApplication | null; collection: LaunchpadNftCollection;
    receipt: CurationReceipt; state: CurationState; caller: string; token: Token;
    evidence?: VerifiedCurationEvidence; until?: string; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void;
}): SignRequest {
    const { action, application, collection, receipt, state, caller, token, evidence, until, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!state.governed || !state.admin || !Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0 ||
        (application !== null && (collection.id !== application.collection || collection.creator !== application.founder)) ||
        receipt.collection !== collection.id || token.userAddress !== caller || token.chainId !== chainId || caller === collection.creator ||
        !eligible(action, receipt, caller, until) ||
        ((action === "feature-propose" || action === "hide-start") && (!evidence?.text.trim() || !evidence.cid || !evidence.sha256))) {
        throw new Error("This editorial action is not ready for wallet review.")
    }
    const title = { "feature-propose": "Propose a feature slot", "feature-approve": "Approve a feature slot",
        "hide-start": "Start a temporary discovery hold", "hide-confirm": "Confirm a discovery hold" }[action]
    const call = buildEditorialMsg(action, collection.id, caller, evidence, until)
    const scope = editorialScope(chainId, collection.id, caller, action)
    const priorReason = action === "feature-approve" ? receipt.feature : action === "hide-confirm" ? receipt.hold : null
    return {
        title, summary: `${collection.name} (${collection.id})`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Manager", caller],
            ["Action", title], ...(until ? [["Feature ends (Unix seconds)", until] as [string, string]] : []),
            ...(evidence ? [["Public reason", evidence.text.length > 180 ? `${evidence.text.slice(0, 180)}…` : evidence.text],
                ["IPFS CID", evidence.cid], ["Exact byte SHA-256", evidence.sha256]] as [string, string][] : []),
            ...(priorReason ? [["Existing reason CID", priorReason.reasonCID], ["Existing reason SHA-256", priorReason.reasonHash]] as [string, string][] : []),
            ["Realm", LAUNCHPAD_CURATION_PATH], ["Network", chainId],
            ["Gas limit", CURATION_ACTION_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`], ["Storage deposit cap", `${DEPOSIT}ugnot`]],
        warns: ["Editorial placement and discovery holds affect presentation only; they do not freeze assets, trades, refunds or claims.",
            "The reason text is public. A second unconflicted manager is required to approve a feature or confirm a hold."],
        acks: ["I checked the collection, current manager role, public reason and network."],
        label: () => `${title} · ${collection.id}`, receipt: scope, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const [freshApp, freshCollection, freshReceipt, freshState, access, other, fetched] = await Promise.all([
                getCurationApplication(rpcUrl, collection.id), getLaunchpadNftCollection(rpcUrl, collection.id),
                getCollectionCuration(rpcUrl, collection.id), getCurationState(rpcUrl),
                readCurationEditorialAccess(collection.id, caller, chainId, token),
                otherActor(action, receipt) ? getCurationEditorialAccess(rpcUrl, collection.id, otherActor(action, receipt)) : Promise.resolve(null),
                evidence ? fetchCurationEvidence(evidence.cid, evidence.sha256) : priorReason ?
                    fetchCurationEvidence(priorReason.reasonCID, priorReason.reasonHash) : Promise.resolve(null),
            ])
            if (!same(freshApp, application) || freshCollection.creator !== collection.creator ||
                !same(freshReceipt, receipt) || !freshState.governed || freshState.admin !== state.admin ||
                !access.isManager || access.creator !== collection.creator ||
                !eligible(action, freshReceipt, caller, until) ||
                (otherActor(action, receipt) && (!other?.isManager || other.creator !== collection.creator)) ||
                (evidence && fetched?.text !== evidence.text) ||
                (priorReason && (!fetched?.text.trim() || fetched.cid !== priorReason.reasonCID || fetched.sha256 !== priorReason.reasonHash))) {
                throw new Error("Manager role, collection, receipt or public reason changed. Refresh before signing.")
            }
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `${title} ${collection.id}`,
            { gasWanted: CURATION_ACTION_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getCollectionCuration(rpcUrl, collection.id)
            if (action === "feature-propose") return fresh.feature?.proposer === caller && fresh.feature.approver === "" &&
                fresh.feature.reasonHash === evidence?.sha256 && fresh.feature.reasonCID === evidence.cid && fresh.feature.until === until && fresh.feature.approvedAt === "0"
            if (action === "feature-approve") return !!fresh.feature && !!receipt.feature && fresh.feature.proposer === receipt.feature.proposer &&
                fresh.feature.approver === caller && fresh.feature.reasonHash === receipt.feature.reasonHash &&
                fresh.feature.reasonCID === receipt.feature.reasonCID && fresh.feature.until === receipt.feature.until && fresh.feature.approvedAt !== "0"
            if (action === "hide-start") return fresh.hidden && fresh.hold?.actor === caller && fresh.hold.confirmer === "" &&
                fresh.hold.reasonHash === evidence?.sha256 && fresh.hold.reasonCID === evidence.cid
            return fresh.hidden && !!fresh.hold && !!receipt.hold && fresh.hold.actor === receipt.hold.actor && fresh.hold.confirmer === caller &&
                fresh.hold.reasonHash === receipt.hold.reasonHash && fresh.hold.reasonCID === receipt.hold.reasonCID &&
                BigInt(fresh.hold.until) >= BigInt(receipt.hold.until)
        },
        onSettled: (outcome) => { if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain lock */ } } input.onSettled?.() },
    }
}

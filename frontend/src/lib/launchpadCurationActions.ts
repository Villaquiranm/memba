/** Reviewed founder application and community-manager decision calls. */
import type { Token } from "../gen/memba/v1/memba_pb"
import { clearGovernanceReceipt, type GovernanceScope } from "./dao/governanceRecovery"
import { isValidGnoAddressChecksum } from "./dao/address"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getCurationApplication, getCurationState, type CurationApplication, type CurationState } from "./launchpadCuration"
import { readCurationAccess } from "./launchpadCurationInbox"
import { fetchCurationEvidence, type VerifiedCurationEvidence } from "./launchpadCurationEvidence"
import { getLaunchpadNftCollection, type LaunchpadNftCollection } from "./launchpadNft"
import { LAUNCHPAD_CURATION_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

export const CURATION_ACTION_GAS_WANTED = 50_000_000
const STORAGE_CAP = 1_000_000
export type CurationDecision = "changes_requested" | "recommended" | "declined"

function sameApp(a: CurationApplication | null, b: CurationApplication | null): boolean {
    if (!a || !b) return a === b
    return a.collection === b.collection && a.founder === b.founder && a.statementHash === b.statementHash &&
        a.statementCID === b.statementCID && a.revision === b.revision && a.status === b.status &&
        a.reviewer === b.reviewer && a.reasonHash === b.reasonHash && a.reasonCID === b.reasonCID && a.updatedAt === b.updatedAt
}

function validateCommon(collection: LaunchpadNftCollection, state: CurationState, caller: string,
    evidence: VerifiedCurationEvidence, fee: number): void {
    if (!/^C[1-9][0-9]{0,17}$/.test(collection.id) || !isValidGnoAddressChecksum(caller) ||
        !state.governed || !isValidGnoAddressChecksum(state.admin) ||
        !Number.isSafeInteger(fee) || fee <= 0 || !evidence.text.trim()) {
        throw new Error("Curation is not ready for a reviewed wallet action.")
    }
}

function evidenceLines(evidence: VerifiedCurationEvidence): [string, string][] {
    return [["Public evidence", evidence.text.length > 180 ? `${evidence.text.slice(0, 180)}…` : evidence.text],
        ["IPFS CID", evidence.cid], ["Exact byte SHA-256", evidence.sha256]]
}

export function curationActionScope(chainId: string, collection: string, caller: string, kind: "apply" | "review"): GovernanceScope {
    return { chainId, realmPath: LAUNCHPAD_CURATION_PATH, caller, operation: `${kind}:${collection}` }
}

export function buildCurationApplyMsg(collection: string, caller: string, evidence: VerifiedCurationEvidence): AminoMsg {
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_CURATION_PATH,
        func: "Apply", args: [collection, evidence.sha256, evidence.cid], max_deposit: `${STORAGE_CAP}ugnot` } }
}

export function curationApplyRequest(input: { collection: LaunchpadNftCollection; prior: CurationApplication | null;
    state: CurationState; caller: string; evidence: VerifiedCurationEvidence; rpcUrl: string; chainId: string;
    estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { collection, prior, state, caller, evidence, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    validateCommon(collection, state, caller, evidence, estimatedGasFeeUgnot)
    if (collection.creator !== caller || (prior && (prior.founder !== caller ||
        (prior.status !== "changes_requested" && prior.status !== "declined")))) {
        throw new Error("Only the creator can apply or resubmit after a review decision.")
    }
    const call = buildCurationApplyMsg(collection.id, caller, evidence)
    const scope = curationActionScope(chainId, collection.id, caller, "apply")
    const revision = prior ? (BigInt(prior.revision) + 1n).toString() : "1"
    return {
        title: prior ? "Resubmit collection for review" : "Apply for collection review",
        summary: `${collection.name} (${collection.id}) · revision ${revision}`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Founder", caller],
            ["Application revision", revision], ...evidenceLines(evidence), ["Realm", LAUNCHPAD_CURATION_PATH],
            ["Network", chainId], ["Gas limit", CURATION_ACTION_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`], ["Storage deposit cap", `${STORAGE_CAP}ugnot`]],
        warns: ["The evidence text and CID are public. Do not include private documents, personal details or confidential founder messages.",
            "Application review does not verify authenticity or promise a feature slot."],
        acks: ["I checked the public evidence, collection creator, network and permanent content address."],
        label: () => `Apply ${collection.id}`, receipt: scope, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const [freshCollection, freshPrior, freshState, fetched] = await Promise.all([
                getLaunchpadNftCollection(rpcUrl, collection.id), getCurationApplication(rpcUrl, collection.id),
                getCurationState(rpcUrl), fetchCurationEvidence(evidence.cid, evidence.sha256),
            ])
            if (freshCollection.creator !== caller || freshCollection.id !== collection.id ||
                !sameApp(prior, freshPrior) || !freshState.governed || freshState.admin !== state.admin ||
                fetched.text !== evidence.text) throw new Error("Collection authority, application or public evidence changed. Refresh before signing.")
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `Apply ${collection.id}`,
            { gasWanted: CURATION_ACTION_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getCurationApplication(rpcUrl, collection.id)
            return !!fresh && fresh.founder === caller && fresh.revision === revision && fresh.status === "submitted" &&
                fresh.statementHash === evidence.sha256 && fresh.statementCID === evidence.cid && fresh.reviewer === "" && fresh.reasonHash === "" && fresh.reasonCID === ""
        },
        onSettled: (outcome) => { if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain lock */ } } input.onSettled?.() },
    }
}

export function buildCurationReviewMsg(collection: string, caller: string, status: CurationDecision,
    evidence: VerifiedCurationEvidence): AminoMsg {
    return { type: "vm/MsgCall", value: { caller, send: "", pkg_path: LAUNCHPAD_CURATION_PATH,
        func: "Review", args: [collection, status, evidence.sha256, evidence.cid], max_deposit: `${STORAGE_CAP}ugnot` } }
}

export function curationReviewRequest(input: { application: CurationApplication; collection: LaunchpadNftCollection;
    state: CurationState; caller: string; token: Token; status: CurationDecision; evidence: VerifiedCurationEvidence;
    rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void }): SignRequest {
    const { application, collection, state, caller, token, status, evidence, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    validateCommon(collection, state, caller, evidence, estimatedGasFeeUgnot)
    if (application.collection !== collection.id || application.founder !== collection.creator || caller === application.founder ||
        (application.status !== "submitted" && application.status !== "changes_requested") ||
        !(["changes_requested", "recommended", "declined"] as string[]).includes(status) ||
        token.userAddress !== caller || token.chainId !== chainId) {
        throw new Error("This wallet cannot review the current founder application.")
    }
    const call = buildCurationReviewMsg(collection.id, caller, status, evidence)
    const scope = curationActionScope(chainId, collection.id, caller, "review")
    return {
        title: "Review founder application", summary: `${collection.name} (${collection.id}) · ${status.replaceAll("_", " ")}`,
        lines: () => [["Collection", `${collection.name} (${collection.id})`], ["Founder", application.founder],
            ["Reviewer", caller], ["Current revision", application.revision], ["Decision", status.replaceAll("_", " ")],
            ...evidenceLines(evidence), ["Realm", LAUNCHPAD_CURATION_PATH], ["Network", chainId],
            ["Gas limit", CURATION_ACTION_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`], ["Storage deposit cap", `${STORAGE_CAP}ugnot`]],
        warns: ["This decision and its reason become public. Recommendation is not DAO authenticity verification or an investment endorsement.",
            "A conflicted or removed manager cannot review; the role is checked again before the wallet opens."],
        acks: ["I checked the founder evidence, decision, public reason, current role and network."],
        label: () => `Review ${collection.id}`, receipt: scope, prepare: () => ({ msgs: [call] }),
        recheck: async () => {
            const [freshApp, freshCollection, freshState, access, fetched] = await Promise.all([
                getCurationApplication(rpcUrl, collection.id), getLaunchpadNftCollection(rpcUrl, collection.id),
                getCurationState(rpcUrl), readCurationAccess(collection.id, caller, chainId, token),
                fetchCurationEvidence(evidence.cid, evidence.sha256),
            ])
            if (!sameApp(application, freshApp) || freshCollection.creator !== application.founder ||
                !freshState.governed || freshState.admin !== state.admin || !access.canReview ||
                access.revision !== application.revision || fetched.text !== evidence.text) {
                throw new Error("Application, manager role or public evidence changed. Refresh before signing.")
            }
        },
        send: (_choice, beforeSign) => doContractBroadcast([call], `Review ${collection.id}`,
            { gasWanted: CURATION_ACTION_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            const fresh = await getCurationApplication(rpcUrl, collection.id)
            return !!fresh && fresh.revision === application.revision && fresh.founder === application.founder &&
                fresh.statementHash === application.statementHash && fresh.statementCID === application.statementCID &&
                fresh.status === status && fresh.reviewer === caller && fresh.reasonHash === evidence.sha256 && fresh.reasonCID === evidence.cid
        },
        onSettled: (outcome) => { if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain lock */ } } input.onSettled?.() },
    }
}

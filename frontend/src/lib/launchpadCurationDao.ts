/** Read-only v13 curation governance. This never enables a wallet action. */
import { z } from "zod"
import { parseQevalJSON, queryEval } from "./dao/shared"
import { address, id, optionalAddress, sha256Hex, time, uint64 } from "./dao/weightedPrimitives"
import { LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_CURATION_PATH } from "./nftConfig"

const schema = "memba-weighted-host/v13" as const
const collection = z.union([z.literal(""), z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)])
const reason = z.union([z.literal(""), sha256Hex])
const state = z.strictObject({
    admin: optionalAddress, pendingAdmin: optionalAddress, governed: z.boolean(), activeManagers: uint64.refine(s => BigInt(s) <= 5n),
    seat: z.strictObject({ account: optionalAddress, lead: z.boolean(), until: uint64 }),
    verification: z.strictObject({ exists: z.boolean(), verified: z.boolean(), reasonHash: z.string().max(64), updatedAt: uint64 }),
    feature: z.strictObject({ exists: z.boolean(), proposer: optionalAddress, approver: optionalAddress, reasonHash: z.string().max(64), until: uint64, approvedAt: uint64 }),
    hold: z.strictObject({ exists: z.boolean(), actor: optionalAddress, confirmer: optionalAddress, reasonHash: z.string().max(64), until: uint64 }),
    conflict: z.boolean(),
})
const operations = ["accept-admin", "return-admin", "abort-return", "appoint-manager", "remove-manager", "mark-conflict", "set-verification", "clear-feature", "clear-hide"] as const
const action = z.strictObject({
    type: z.literal("curation"), target: z.literal(LAUNCHPAD_CURATION_PATH), operation: z.enum(operations),
    recipient: optionalAddress, manager: optionalAddress, collection, reasonHash: reason,
    lead: z.boolean(), verified: z.boolean(), until: uint64, before: state,
}).superRefine((a, ctx) => {
    const fail = () => ctx.addIssue({ code: "custom", message: "Inconsistent curation action" })
    const returnOp = a.operation === "return-admin" || a.operation === "abort-return"
    const managerOp = a.operation === "appoint-manager" || a.operation === "remove-manager" || a.operation === "mark-conflict"
    const collectionOp = a.operation === "mark-conflict" || a.operation === "set-verification" || a.operation === "clear-feature" || a.operation === "clear-hide"
    const reasonOp = a.operation === "set-verification" || a.operation === "clear-feature" || a.operation === "clear-hide"
    if ((a.recipient !== "") !== returnOp || (a.manager !== "") !== managerOp || (a.collection !== "") !== collectionOp || (a.reasonHash !== "") !== reasonOp) fail()
    if (a.operation !== "appoint-manager" && (a.lead || a.until !== "0") || a.operation !== "set-verification" && a.verified) fail()
    if (a.operation === "appoint-manager" && a.until === "0") fail()
})
const invalidation = z.strictObject({ cause: z.enum(["superseded-execution", "pause"]), height: uint64, proposalId: id.nullable(), target: z.literal(LAUNCHPAD_CURATION_PATH).nullable() })
    .refine(v => v.cause === "pause" ? v.proposalId === null && v.target !== null : v.proposalId !== null, "Inconsistent invalidation record")
const proposal = z.strictObject({
    id, proposer: address, action, category: z.literal("critical"),
    status: z.enum(["VOTING", "TIMELOCKED", "READY", "EXPIRED", "INVALIDATED", "EXECUTED"]),
    qualified: z.boolean(), ready: z.boolean(), votingClosed: z.boolean(), talliesAvailable: z.boolean(),
    weightYes: z.number().int().min(0).max(8).nullable(), peopleYes: z.number().int().min(0).max(7).nullable(), developersYes: z.number().int().min(0).max(6).nullable(),
    createdAt: time, votingDeadline: time, weightedAfter: time.nullable(), developerAfter: time.nullable(), invalidation: invalidation.nullable(),
}).refine(p => {
    if (p.ready !== (p.status === "READY") || Date.parse(p.votingDeadline) - Date.parse(p.createdAt) !== 604800000) return false
    if ((p.invalidation === null) === (p.status === "INVALIDATED") || p.invalidation?.proposalId === p.id) return false
    const cleared = p.status === "EXECUTED" || p.status === "INVALIDATED" || p.status === "EXPIRED" && !p.talliesAvailable
    if (p.talliesAvailable === cleared || p.status === "EXPIRED" && !p.votingClosed) return false
    if (cleared) return p.weightYes === null && p.peopleYes === null && p.developersYes === null && !p.qualified && p.weightedAfter === null && p.developerAfter === null
    if (p.weightYes === null || p.peopleYes === null || p.developersYes === null) return false
    if (p.peopleYes < p.developersYes || p.peopleYes - p.developersYes > 1 || p.weightYes !== p.developersYes + 2 * (p.peopleYes - p.developersYes)) return false
    if (p.status === "VOTING" && p.votingClosed) return false
    const qualified = p.weightedAfter !== null || p.developerAfter !== null
    return p.qualified === qualified && p.qualified === (p.status === "TIMELOCKED" || p.status === "READY") &&
        (p.weightedAfter === null || p.weightYes >= 6 && p.peopleYes >= 4) && (p.developerAfter === null || p.developersYes >= 5)
}, "Inconsistent curation proposal")
const config = z.strictObject({
    schema: z.literal(schema), kind: z.literal("config"), realmPath: z.literal(LAUNCHPAD_CURATION_DAO_PATH),
    rosterSize: z.literal(7), totalPoints: z.literal(8), founderWeight: z.literal(2), developerWeight: z.literal(1),
    votingPeriodSeconds: z.literal(604800), roleChanges: z.strictObject({ category: z.literal("critical"), weightedPoints: z.literal(6), weightedPeople: z.literal(4), weightedDelaySeconds: z.literal(86400), independentDevelopers: z.literal(5), independentDelaySeconds: z.literal(259200) }),
    mutableRoles: z.tuple([z.literal("admin"), z.literal("finance")]),
    capabilities: z.strictObject({ roleProposals: z.literal(true), memberReplacement: z.literal(true), migration: z.literal(false), treasuryExecution: z.literal(false), applicationActions: z.literal(true) }),
    maxProposalPage: z.literal(50),
    curationPolicy: z.strictObject({ target: z.literal(LAUNCHPAD_CURATION_PATH), successor: address, actionCategory: z.literal("critical"), maxManagers: z.literal(5), maxTermSeconds: z.literal(7776000), returnStagesOnly: z.literal(true), invalidatesOtherProposals: z.literal(true) }),
})
const page = z.strictObject({ schema: z.literal(schema), kind: z.literal("proposals"), total: uint64, proposals: z.array(z.unknown()).max(20), nextBefore: id.nullable() })

export type CurationDaoProposal = z.infer<typeof proposal>
export type CurationDaoSnapshot = { successor: string; total: string; proposals: CurationDaoProposal[]; nextBefore: string | null }

async function read(rpcUrl: string, expression: string): Promise<unknown> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_CURATION_DAO_PATH, expression, true)
    if (raw === null) throw new Error("Could not read curation DAO")
    return parseQevalJSON(raw)
}

/** Unknown role/recovery proposals are omitted from this curation-only view. Malformed curation proposals fail the page. */
export async function readCurationDaoSnapshot(rpcUrl: string, before = "0"): Promise<CurationDaoSnapshot> {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(before) || BigInt(before) > 18446744073709551615n) throw new Error("Invalid governance cursor")
    const [rawConfig, rawPage] = await Promise.all([read(rpcUrl, "GetConfigJSON()"), read(rpcUrl, `GetProposalsJSON(${before}, 20)`)])
    const policy = config.parse(rawConfig)
    const result = page.parse(rawPage)
    const proposals: CurationDaoProposal[] = []
    for (const item of result.proposals) {
        if (typeof item !== "object" || item === null || Array.isArray(item) || !("action" in item) || typeof item.action !== "object" || item.action === null || Array.isArray(item.action) || !("type" in item.action)) throw new Error("Unknown DAO proposal shape")
        if (item.action.type === "curation") proposals.push(proposal.parse(item))
        else if (item.action.type !== "set-role" && item.action.type !== "recover-member") throw new Error("Unknown DAO action type")
    }
    if (new Set(proposals.map(item => item.id)).size !== proposals.length) throw new Error("Duplicate curation proposal")
    return { successor: policy.curationPolicy.successor, total: result.total, proposals, nextBefore: result.nextBefore }
}

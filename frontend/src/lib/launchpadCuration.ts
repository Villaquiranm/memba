/** Strict public reads for the unpublished Launchpad curation registry. */
import { z } from "zod"
import { queryEval, parseQevalJSON } from "./dao/shared"
import { address, optionalAddress, sha256Hex } from "./dao/weightedPrimitives"
import { LAUNCHPAD_CURATION_PATH } from "./nftConfig"

const MAX_INT64 = 9223372036854775807n
const collection = z.string().regex(/^C[1-9][0-9]*$/)
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((s) => BigInt(s) <= MAX_INT64)
const positive = uint.refine((s) => s !== "0")
const evidenceCID = z.string().regex(/^(bafy[a-z2-7]{55,86}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/)
const state = z.strictObject({ admin: address, pendingAdmin: optionalAddress, governed: z.boolean(), activeManagers: z.number().int().min(0).max(5) })
const seat = z.strictObject({ account: address, lead: z.boolean(), until: positive, active: z.boolean() })
const application = z.strictObject({
    collection, founder: address, statementHash: sha256Hex, statementCID: evidenceCID, revision: positive,
    status: z.enum(["submitted", "changes_requested", "recommended", "declined"]),
    reviewer: optionalAddress, reasonHash: z.union([z.literal(""), sha256Hex]), reasonCID: z.union([z.literal(""), evidenceCID]), updatedAt: positive,
}).refine((a) => a.status === "submitted" ? a.reviewer === "" && a.reasonHash === "" && a.reasonCID === "" :
    a.reviewer !== "" && a.reasonHash !== "" && a.reasonCID !== "", "Inconsistent application review")
const feature = z.strictObject({ proposer: address, approver: optionalAddress, reasonHash: sha256Hex, reasonCID: evidenceCID, until: positive, approvedAt: uint })
    .refine((f) => f.approver === "" ? f.approvedAt === "0" : f.approvedAt !== "0" && BigInt(f.approvedAt) < BigInt(f.until), "Inconsistent feature approval")
const hold = z.strictObject({ actor: address, confirmer: optionalAddress, reasonHash: sha256Hex, reasonCID: evidenceCID, until: positive })
const verification = z.strictObject({ verified: z.boolean(), reasonHash: sha256Hex, updatedAt: positive })
const receipt = z.strictObject({ collection, featured: z.boolean(), hidden: z.boolean(), feature: feature.nullable(), hold: hold.nullable(), verification: verification.nullable() })
    .refine((r) => (!r.featured || (r.feature !== null && r.feature.approver !== "" && !r.hidden)) && (!r.hidden || r.hold !== null), "Inconsistent curation receipt")
const reviewAccess = z.strictObject({ collection, account: address, founder: address, revision: positive,
    status: z.enum(["submitted", "changes_requested", "recommended", "declined"]),
    isFounder: z.boolean(), isManager: z.boolean(), canRead: z.boolean(), canReview: z.boolean(),
}).refine((v) => v.isFounder === (v.account === v.founder) && !(v.isFounder && v.isManager) &&
    v.canRead === (v.isFounder || v.isManager) &&
    v.canReview === (v.isManager && (v.status === "submitted" || v.status === "changes_requested")), "Inconsistent curation access")

export type CurationState = z.infer<typeof state>
export type CurationSeat = z.infer<typeof seat>
export type CurationApplication = z.infer<typeof application>
export type CurationReceipt = z.infer<typeof receipt>
export type CurationReviewAccess = z.infer<typeof reviewAccess>

async function read(rpcUrl: string, expression: string): Promise<unknown> {
    const raw = await queryEval(rpcUrl, LAUNCHPAD_CURATION_PATH, expression, true)
    if (raw === null) throw new Error("Could not read Launchpad curation")
    return parseQevalJSON(raw)
}

export async function getCurationState(rpcUrl: string): Promise<CurationState> {
    return state.parse(await read(rpcUrl, "StateJSON()"))
}

export async function listCurationManagers(rpcUrl: string): Promise<CurationSeat[]> {
    const rows = z.array(seat).max(5).parse(await read(rpcUrl, "ManagersJSON()"))
    if (new Set(rows.map((s) => s.account)).size !== rows.length || rows.some((s) => !s.active)) throw new Error("Inconsistent manager roster")
    return rows
}

export async function listCurationApplications(rpcUrl: string, page = 0, size = 20): Promise<CurationApplication[]> {
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1 || size > 100) throw new Error("Invalid application page")
    const rows = z.array(application).max(size).parse(await read(rpcUrl, `ApplicationsJSON(${page}, ${size})`))
    if (new Set(rows.map((a) => a.collection)).size !== rows.length) throw new Error("Duplicate application")
    return rows
}

export async function getCurationApplication(rpcUrl: string, id: string): Promise<CurationApplication | null> {
    if (!collection.safeParse(id).success) throw new Error("Invalid collection ID")
    const result = application.nullable().parse(await read(rpcUrl, `ApplicationJSON(${JSON.stringify(id)})`))
    if (result && result.collection !== id) throw new Error("Curation application collection mismatch")
    return result
}

export async function getCollectionCuration(rpcUrl: string, id: string): Promise<CurationReceipt> {
    if (!collection.safeParse(id).success) throw new Error("Invalid collection ID")
    const result = receipt.parse(await read(rpcUrl, `CollectionCurationJSON(${JSON.stringify(id)})`))
    if (result.collection !== id) throw new Error("Curation receipt collection mismatch")
    return result
}

/** Public eligibility snapshot for checking the other manager in a two-person decision. */
export async function getCurationReviewAccess(rpcUrl: string, id: string, account: string): Promise<CurationReviewAccess | null> {
    if (!collection.safeParse(id).success || !address.safeParse(account).success) throw new Error("Invalid curation access target")
    const result = reviewAccess.nullable().parse(await read(rpcUrl, `ReviewAccessJSON(${JSON.stringify(id)}, ${JSON.stringify(account)})`))
    if (result && (result.collection !== id || result.account !== account)) throw new Error("Curation access target mismatch")
    return result
}

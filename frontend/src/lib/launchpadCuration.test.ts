import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { bech32Encode } from "./dao/realmAddress"
import { LAUNCHPAD_CURATION_PATH } from "./nftConfig"
import { getCollectionCuration, getCurationApplication, getCurationEditorialAccess, getCurationReviewAccess, getCurationState, listCurationApplications, listCurationManagers } from "./launchpadCuration"

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const digest = (c: string) => c.repeat(64)
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`
const app = { collection: "C1", founder: addr(1), statementHash: digest("a"), statementCID: cid, revision: "1",
    status: "submitted", reviewer: "", reasonHash: "", reasonCID: "", updatedAt: "100" }
const feature = { proposer: addr(2), approver: addr(3), reasonHash: digest("b"), reasonCID: cid, until: "200", approvedAt: "100" }

describe("Launchpad curation reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("reads a bounded DAO manager roster with exact realm path", async () => {
        const query = vi.spyOn(shared, "queryEval")
            .mockResolvedValueOnce(qeval({ admin: addr(4), pendingAdmin: "", governed: true, activeManagers: 2 }))
            .mockResolvedValueOnce(qeval([{ account: addr(2), lead: true, until: "200", active: true }, { account: addr(3), lead: false, until: "200", active: true }]))
        expect((await getCurationState("rpc")).activeManagers).toBe(2)
        expect(await listCurationManagers("rpc")).toHaveLength(2)
        expect(query).toHaveBeenNthCalledWith(1, "rpc", LAUNCHPAD_CURATION_PATH, "StateJSON()", true)
        expect(query).toHaveBeenNthCalledWith(2, "rpc", LAUNCHPAD_CURATION_PATH, "ManagersJSON()", true)
    })

    it("refuses missing data, forged roster entries and excess seats", async () => {
        vi.spyOn(shared, "queryEval").mockResolvedValueOnce(null)
            .mockResolvedValueOnce(qeval([{ account: addr(2), lead: false, until: "200", active: false }]))
            .mockResolvedValueOnce(qeval(Array(6).fill({ account: addr(2), lead: false, until: "200", active: true })))
        await expect(getCurationState("rpc")).rejects.toThrow("Could not read")
        await expect(listCurationManagers("rpc")).rejects.toThrow("Inconsistent manager roster")
        await expect(listCurationManagers("rpc")).rejects.toThrow()
    })

    it("validates founder application status, hashes and pagination", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval([app]))
        expect(await listCurationApplications("rpc", 1, 20)).toEqual([app])
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_PATH, "ApplicationsJSON(1, 20)", true)
        query.mockResolvedValueOnce(qeval([{ ...app, status: "recommended" }]))
        await expect(listCurationApplications("rpc")).rejects.toThrow("Inconsistent application review")
        query.mockResolvedValueOnce(qeval([{ ...app, statementCID: "https://example.com" }]))
        await expect(listCurationApplications("rpc")).rejects.toThrow()
        query.mockResolvedValueOnce(qeval([app, app]))
        await expect(listCurationApplications("rpc")).rejects.toThrow("Duplicate application")
        await expect(listCurationApplications("rpc", -1)).rejects.toThrow("Invalid application page")
    })

    it("reads one exact application or an explicit missing record", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(app)).mockResolvedValueOnce(qeval(null))
            .mockResolvedValueOnce(qeval({ ...app, collection: "C2" }))
        expect(await getCurationApplication("rpc", "C1")).toEqual(app)
        expect(await getCurationApplication("rpc", "C1")).toBeNull()
        await expect(getCurationApplication("rpc", "C1")).rejects.toThrow("mismatch")
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_PATH, 'ApplicationJSON("C1")', true)
    })

    it("binds public feature, hold and verification facts to one collection", async () => {
        const query = vi.spyOn(shared, "queryEval")
            .mockResolvedValueOnce(qeval({ collection: "C1", featured: true, hidden: false, feature, hold: null, verification: { verified: true, reasonHash: digest("c"), reasonCID: cid, updatedAt: "101" } }))
            .mockResolvedValueOnce(qeval({ collection: "C2", featured: true, hidden: false, feature, hold: null, verification: null }))
            .mockResolvedValueOnce(qeval({ collection: "C1", featured: true, hidden: true, feature, hold: { actor: addr(2), confirmer: "", reasonHash: digest("d"), reasonCID: cid, until: "200" }, verification: null }))
        expect((await getCollectionCuration("rpc", "C1")).verification?.verified).toBe(true)
        expect(query).toHaveBeenNthCalledWith(1, "rpc", LAUNCHPAD_CURATION_PATH, 'CollectionCurationJSON("C1")', true)
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow("mismatch")
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow("Inconsistent curation receipt")
        await expect(getCollectionCuration("rpc", "bad")).rejects.toThrow("Invalid collection ID")
        query.mockResolvedValueOnce(qeval({ collection: "C1", featured: true, hidden: false, feature: { ...feature, reasonCID: "invalid" }, hold: null, verification: null }))
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow()
        query.mockResolvedValueOnce(qeval({ collection: "C1", featured: false, hidden: false, feature: null, hold: null, verification: { verified: true, reasonHash: digest("c"), reasonCID: "invalid", updatedAt: "101" } }))
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow()
    })

    it("checks the other manager's live public eligibility for a two-person action", async () => {
        const access = { collection: "C1", account: addr(2), founder: addr(1), revision: "1", status: "recommended",
            isFounder: false, isManager: true, canRead: true, canReview: false }
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(access))
            .mockResolvedValueOnce(qeval({ ...access, isManager: false }))
            .mockResolvedValueOnce(qeval({ ...access, account: addr(3) }))
        expect((await getCurationReviewAccess("rpc", "C1", addr(2)))?.isManager).toBe(true)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_PATH, `ReviewAccessJSON("C1", "${addr(2)}")`, true)
        await expect(getCurationReviewAccess("rpc", "C1", addr(2))).rejects.toThrow("Inconsistent")
        await expect(getCurationReviewAccess("rpc", "C1", addr(2))).rejects.toThrow("mismatch")
    })

    it("reads editorial eligibility for a collection without an application", async () => {
        const access = { collection: "C1", account: addr(2), creator: addr(1), isManager: true }
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(access))
            .mockResolvedValueOnce(qeval({ ...access, creator: addr(2) }))
            .mockResolvedValueOnce(qeval({ ...access, collection: "C2" }))
        expect(await getCurationEditorialAccess("rpc", "C1", addr(2))).toEqual(access)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_PATH, `EditorialAccessJSON("C1", "${addr(2)}")`, true)
        await expect(getCurationEditorialAccess("rpc", "C1", addr(2))).rejects.toThrow("Inconsistent")
        await expect(getCurationEditorialAccess("rpc", "C1", addr(2))).rejects.toThrow("mismatch")
    })
})

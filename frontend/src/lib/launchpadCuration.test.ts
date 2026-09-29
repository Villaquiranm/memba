import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { bech32Encode } from "./dao/realmAddress"
import { LAUNCHPAD_CURATION_PATH } from "./nftConfig"
import { getCollectionCuration, getCurationState, listCurationApplications, listCurationManagers } from "./launchpadCuration"

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const digest = (c: string) => c.repeat(64)
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`
const app = { collection: "C1", founder: addr(1), statementHash: digest("a"), statementCID: cid, revision: "1",
    status: "submitted", reviewer: "", reasonHash: "", reasonCID: "", updatedAt: "100" }
const feature = { proposer: addr(2), approver: addr(3), reasonHash: digest("b"), until: "200", approvedAt: "100" }

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

    it("binds public feature, hold and verification facts to one collection", async () => {
        const query = vi.spyOn(shared, "queryEval")
            .mockResolvedValueOnce(qeval({ collection: "C1", featured: true, hidden: false, feature, hold: null, verification: { verified: true, reasonHash: digest("c"), updatedAt: "101" } }))
            .mockResolvedValueOnce(qeval({ collection: "C2", featured: true, hidden: false, feature, hold: null, verification: null }))
            .mockResolvedValueOnce(qeval({ collection: "C1", featured: true, hidden: true, feature, hold: { actor: addr(2), confirmer: "", reasonHash: digest("d"), until: "200" }, verification: null }))
        expect((await getCollectionCuration("rpc", "C1")).verification?.verified).toBe(true)
        expect(query).toHaveBeenNthCalledWith(1, "rpc", LAUNCHPAD_CURATION_PATH, 'CollectionCurationJSON("C1")', true)
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow("mismatch")
        await expect(getCollectionCuration("rpc", "C1")).rejects.toThrow("Inconsistent curation receipt")
        await expect(getCollectionCuration("rpc", "bad")).rejects.toThrow("Invalid collection ID")
    })
})

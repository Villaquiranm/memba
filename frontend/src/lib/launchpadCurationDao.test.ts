import { beforeEach, describe, expect, it, vi } from "vitest"
import * as shared from "./dao/shared"
import { bech32Encode } from "./dao/realmAddress"
import { LAUNCHPAD_CURATION_DAO_PATH, LAUNCHPAD_CURATION_PATH } from "./nftConfig"
import { readCurationDaoSnapshot } from "./launchpadCurationDao"

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`
const before = {
    admin: addr(1), pendingAdmin: "", governed: true, activeManagers: "0",
    seat: { account: "", lead: false, until: "0" },
    verification: { exists: false, verified: false, reasonHash: "", reasonCID: "", updatedAt: "0" },
    feature: { exists: false, proposer: "", approver: "", reasonHash: "", reasonCID: "", until: "0", approvedAt: "0" },
    hold: { exists: false, actor: "", confirmer: "", reasonHash: "", reasonCID: "", until: "0" }, conflict: false,
}
const config = {
    schema: "memba-weighted-host/v13", kind: "config", realmPath: LAUNCHPAD_CURATION_DAO_PATH,
    rosterSize: 7, totalPoints: 8, founderWeight: 2, developerWeight: 1, votingPeriodSeconds: 604800,
    roleChanges: { category: "critical", weightedPoints: 6, weightedPeople: 4, weightedDelaySeconds: 86400, independentDevelopers: 5, independentDelaySeconds: 259200 },
    mutableRoles: ["admin", "finance"], capabilities: { roleProposals: true, memberReplacement: true, migration: false, treasuryExecution: false, applicationActions: true },
    maxProposalPage: 50, curationPolicy: { target: LAUNCHPAD_CURATION_PATH, successor: addr(2), actionCategory: "critical", maxManagers: 5, maxTermSeconds: 7776000, returnStagesOnly: true, invalidatesOtherProposals: true },
}
const roster = { schema: config.schema, kind: "members", members: Array.from({ length: 7 }, (_, n) => ({
    personId: `member-${n}`, address: addr(n + 10), founder: n === 0, weight: n === 0 ? 2 : 1,
    admin: n === 0, finance: n === 1,
})) }
const proposal = {
    id: "3", proposer: addr(3), action: { type: "curation", target: LAUNCHPAD_CURATION_PATH, operation: "appoint-manager", recipient: "", manager: addr(4), collection: "", reasonHash: "", reasonCID: "", lead: false, verified: false, until: "1702851200", before },
    category: "critical", status: "VOTING", qualified: false, ready: false, votingClosed: false, talliesAvailable: true,
    weightYes: 0, peopleYes: 0, developersYes: 0, createdAt: "2023-11-20T22:13:20Z", votingDeadline: "2023-11-27T22:13:20Z", weightedAfter: null, developerAfter: null, invalidation: null,
}
const page = { schema: config.schema, kind: "proposals", total: "3", proposals: [proposal], nextBefore: "3" }

describe("v13 NFT curation DAO reads", () => {
    beforeEach(() => vi.restoreAllMocks())

    it("reads only the isolated DAO path and parses typed curation proposals", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval(page))
        const result = await readCurationDaoSnapshot("rpc")
        expect(result.proposals).toHaveLength(1)
        expect(result.proposals[0].action.operation).toBe("appoint-manager")
        expect(result.nextBefore).toBe("3")
        expect(result.members).toHaveLength(7)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_DAO_PATH, "GetConfigJSON()", true)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_DAO_PATH, "GetMembersJSON()", true)
        expect(query).toHaveBeenCalledWith("rpc", LAUNCHPAD_CURATION_DAO_PATH, "GetProposalsJSON(0, 20)", true)
    })

    it("rejects a v12 response, wrong target or malformed curation action", async () => {
        const query = vi.spyOn(shared, "queryEval")
        query.mockResolvedValueOnce(qeval({ ...config, schema: "memba-weighted-host/v12" })).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval(page))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow()
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...proposal, action: { ...proposal.action, target: "gno.land/r/other/curation" } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow()
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...proposal, action: { ...proposal.action, recipient: addr(5) } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow()
    })

    it("refuses duplicate curation IDs and untrusted pagination", async () => {
        const query = vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [proposal, proposal] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Duplicate curation proposal")
        await expect(readCurationDaoSnapshot("rpc", "1); Vote(3")).rejects.toThrow("Invalid governance cursor")
        expect(query).toHaveBeenCalledTimes(3)
    })

    it("omits role proposals but never silently drops a malformed curation proposal", async () => {
        const query = vi.spyOn(shared, "queryEval")
        const role = { ...proposal, id: "2", action: { type: "set-role", target: addr(5), role: "admin", grant: true } }
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [role, proposal] }))
        expect((await readCurationDaoSnapshot("rpc")).proposals.map(p => p.id)).toEqual(["3"])
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...proposal, status: "READY", ready: false }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Inconsistent curation proposal")
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster)).mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...proposal, action: { type: "arbitrary-call" } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Unknown DAO action type")
    })

    it("rejects a malformed or duplicate weighted roster", async () => {
        const query = vi.spyOn(shared, "queryEval")
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval({ ...roster, members: roster.members.map((m, n) => n === 1 ? { ...m, address: roster.members[0].address } : m) })).mockResolvedValueOnce(qeval(page))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Invalid curation DAO roster")
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval({ ...roster, schema: "memba-weighted-host/v12" })).mockResolvedValueOnce(qeval(page))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow()
    })

    it("rejects a feature prestate whose public evidence pointer is missing", async () => {
        vi.spyOn(shared, "queryEval").mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster))
            .mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...proposal, action: { ...proposal.action,
                before: { ...before, feature: { ...before.feature, exists: true, reasonHash: "a".repeat(64) } } } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Inconsistent feature evidence")
    })

    it("requires a committed public CID for DAO verification and clearance reasons", async () => {
        const query = vi.spyOn(shared, "queryEval")
        const editorial = { ...proposal, action: { ...proposal.action, operation: "set-verification", manager: "",
            collection: "C1", reasonHash: "a".repeat(64), reasonCID: cid, verified: true, until: "0" } }
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster))
            .mockResolvedValueOnce(qeval({ ...page, proposals: [editorial] }))
        expect((await readCurationDaoSnapshot("rpc")).proposals[0].action.reasonCID).toBe(cid)
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster))
            .mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...editorial, action: { ...editorial.action, reasonCID: "" } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Inconsistent curation action")
        query.mockResolvedValueOnce(qeval(config)).mockResolvedValueOnce(qeval(roster))
            .mockResolvedValueOnce(qeval({ ...page, proposals: [{ ...editorial, action: { ...editorial.action,
                before: { ...before, verification: { ...before.verification, exists: true, verified: true, reasonHash: "b".repeat(64) } } } }] }))
        await expect(readCurationDaoSnapshot("rpc")).rejects.toThrow("Inconsistent verification evidence")
    })
})

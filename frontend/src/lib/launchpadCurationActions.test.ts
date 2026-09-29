import { beforeEach, describe, expect, it, vi } from "vitest"
import { bech32Encode } from "./dao/realmAddress"
import { buildCurationApplyMsg, buildCurationReviewMsg, curationApplyRequest, curationReviewRequest } from "./launchpadCurationActions"
import type { CurationApplication, CurationState } from "./launchpadCuration"
import type { LaunchpadNftCollection } from "./launchpadNft"

const getApplication = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn())
const getCollection = vi.hoisted(() => vi.fn())
const readAccess = vi.hoisted(() => vi.fn())
const fetchEvidence = vi.hoisted(() => vi.fn())
const broadcast = vi.hoisted(() => vi.fn())
vi.mock("./launchpadCuration", () => ({ getCurationApplication: getApplication, getCurationState: getState }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: getCollection }))
vi.mock("./launchpadCurationInbox", () => ({ readCurationAccess: readAccess }))
vi.mock("./launchpadCurationEvidence", () => ({ fetchCurationEvidence: fetchEvidence }))
vi.mock("./grc20", async (original) => ({ ...(await original<typeof import("./grc20")>()), doContractBroadcast: broadcast }))

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const founder = addr(1)
const manager = addr(2)
const admin = addr(3)
const collection = { id: "C1", creator: founder, name: "Gno Originals" } as LaunchpadNftCollection
const state = { admin, pendingAdmin: "", governed: true, activeManagers: 1 } as CurationState
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const evidence = { cid, sha256: "a".repeat(64), text: "Public artist and collection history" }
const application = { collection: "C1", founder, statementHash: "b".repeat(64), statementCID: cid, revision: "1",
    status: "submitted", reviewer: "", reasonHash: "", reasonCID: "", updatedAt: "100" } as CurationApplication
const token = { userAddress: manager, chainId: "gnoland-1" } as never
const common = { collection, state, evidence, rpcUrl: "rpc", chainId: "gnoland-1", estimatedGasFeeUgnot: 1234 }

describe("curation wallet reviews", () => {
    beforeEach(() => {
        getApplication.mockReset().mockResolvedValue(application)
        getState.mockReset().mockResolvedValue(state)
        getCollection.mockReset().mockResolvedValue(collection)
        readAccess.mockReset().mockResolvedValue({ canReview: true, revision: "1" })
        fetchEvidence.mockReset().mockResolvedValue(evidence)
        broadcast.mockReset().mockResolvedValue({ hash: "tx" })
    })

    it("commits founder public evidence and checks creator, revision and bytes again", async () => {
        const req = curationApplyRequest({ ...common, prior: null, caller: founder })
        expect(req.prepare(undefined).msgs).toEqual([buildCurationApplyMsg("C1", founder, evidence)])
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "Apply", args: ["C1", evidence.sha256, cid], send: "" })
        getApplication.mockResolvedValueOnce(null)
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        getApplication.mockResolvedValueOnce({ ...application, statementHash: evidence.sha256 })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        getApplication.mockResolvedValueOnce({ ...application, statementHash: evidence.sha256, revision: "1" })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
    })

    it("rejects a noncreator and an application already under review", () => {
        expect(() => curationApplyRequest({ ...common, prior: null, caller: manager })).toThrow("Only the creator")
        expect(() => curationApplyRequest({ ...common, prior: application, caller: founder })).toThrow("Only the creator")
    })

    it("binds manager decision to a live unconflicted role and exact application", async () => {
        const req = curationReviewRequest({ ...common, application, caller: manager, token, status: "changes_requested" })
        expect(req.prepare(undefined).msgs).toEqual([buildCurationReviewMsg("C1", manager, "changes_requested", evidence)])
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "Review", args: ["C1", "changes_requested", evidence.sha256, cid], send: "" })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        readAccess.mockResolvedValueOnce({ canReview: false, revision: "1" })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        getApplication.mockResolvedValueOnce({ ...application, status: "changes_requested", reviewer: manager,
            reasonHash: evidence.sha256, reasonCID: cid })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
    })
})

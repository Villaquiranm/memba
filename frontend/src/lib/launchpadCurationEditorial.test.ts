import { beforeEach, describe, expect, it, vi } from "vitest"
import { bech32Encode } from "./dao/realmAddress"
import { buildEditorialMsg, editorialRequest } from "./launchpadCurationEditorial"
import type { CurationApplication, CurationReceipt, CurationState } from "./launchpadCuration"
import type { LaunchpadNftCollection } from "./launchpadNft"

const getApplication = vi.hoisted(() => vi.fn())
const getReceipt = vi.hoisted(() => vi.fn())
const getState = vi.hoisted(() => vi.fn())
const getOther = vi.hoisted(() => vi.fn())
const getCollection = vi.hoisted(() => vi.fn())
const readAccess = vi.hoisted(() => vi.fn())
const fetchEvidence = vi.hoisted(() => vi.fn())
const broadcast = vi.hoisted(() => vi.fn())
vi.mock("./launchpadCuration", () => ({ getCurationApplication: getApplication, getCollectionCuration: getReceipt,
    getCurationState: getState, getCurationEditorialAccess: getOther }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: getCollection }))
vi.mock("./launchpadCurationInbox", () => ({ readCurationEditorialAccess: readAccess }))
vi.mock("./launchpadCurationEvidence", () => ({ fetchCurationEvidence: fetchEvidence }))
vi.mock("./grc20", async (original) => ({ ...(await original<typeof import("./grc20")>()), doContractBroadcast: broadcast }))

const addr = (n: number) => bech32Encode("g", new Uint8Array(20).fill(n))
const founder = addr(1), proposer = addr(2), manager = addr(3), admin = addr(4)
const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf6bzut6qzzmtnkzqf54j7efm5e"
const evidence = { cid, sha256: "a".repeat(64), text: "Public community feature rationale" }
const collection = { id: "C1", creator: founder, name: "Gno Originals" } as LaunchpadNftCollection
const application = { collection: "C1", founder, statementHash: "b".repeat(64), statementCID: cid,
    revision: "1", status: "recommended", reviewer: proposer, reasonHash: "c".repeat(64), reasonCID: cid,
    updatedAt: "100" } as CurationApplication
const state = { admin, pendingAdmin: "", governed: true, activeManagers: 2 } as CurationState
const baseReceipt = { collection: "C1", featured: false, hidden: false, feature: null, hold: null,
    verification: null } as CurationReceipt
const feature = { proposer, approver: "", reasonHash: evidence.sha256, reasonCID: cid,
    until: String(Math.floor(Date.now() / 1000) + 86_400), approvedAt: "0" }
const hold = { actor: proposer, confirmer: "", reasonHash: evidence.sha256, reasonCID: cid,
    until: String(Math.floor(Date.now() / 1000) + 86_400) }
const token = { userAddress: manager, chainId: "gnoland-1" } as never
const common = { application, collection, state, caller: manager, token, rpcUrl: "rpc", chainId: "gnoland-1",
    estimatedGasFeeUgnot: 1234 }

describe("direct manager editorial wallet actions", () => {
    beforeEach(() => {
        getApplication.mockReset().mockResolvedValue(application)
        getReceipt.mockReset().mockResolvedValue(baseReceipt)
        getState.mockReset().mockResolvedValue(state)
        getOther.mockReset().mockResolvedValue({ isManager: true, creator: founder })
        getCollection.mockReset().mockResolvedValue(collection)
        readAccess.mockReset().mockResolvedValue({ isManager: true, creator: founder })
        fetchEvidence.mockReset().mockResolvedValue(evidence)
        broadcast.mockReset().mockResolvedValue({ hash: "tx" })
    })

    it("proposes a bounded feature with exact public bytes and locks stale receipts", async () => {
        const until = String(Math.floor(Date.now() / 1000) + 7 * 86_400)
        const req = editorialRequest({ ...common, action: "feature-propose", receipt: baseReceipt, evidence, until })
        expect(req.prepare(undefined).msgs).toEqual([buildEditorialMsg("feature-propose", "C1", manager, evidence, until)])
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "ProposeFeature", args: ["C1", evidence.sha256, cid, until], send: "" })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        getReceipt.mockResolvedValueOnce({ ...baseReceipt, verification: { verified: true, reasonHash: "d".repeat(64), updatedAt: "100" } })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        getReceipt.mockResolvedValueOnce({ ...baseReceipt, feature: { ...feature, proposer: manager, until } })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
    })

    it("requires a separate currently eligible manager before approving", async () => {
        const receipt = { ...baseReceipt, feature }
        getReceipt.mockResolvedValue(receipt)
        const req = editorialRequest({ ...common, action: "feature-approve", receipt })
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "ApproveFeature", args: ["C1"] })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        fetchEvidence.mockRejectedValueOnce(new Error("Public evidence bytes do not match the on-chain hash."))
        await expect(req.recheck?.(undefined)).rejects.toThrow("do not match")
        getOther.mockResolvedValueOnce({ isManager: false, creator: founder })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        getReceipt.mockResolvedValueOnce({ ...receipt, featured: true, feature: { ...feature, approver: manager, approvedAt: "100" } })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
        expect(() => editorialRequest({ ...common, action: "feature-approve", receipt: { ...receipt,
            feature: { ...feature, proposer: manager } } })).toThrow("not ready")
    })

    it("starts a short discovery hold without changing any trade authority", async () => {
        const req = editorialRequest({ ...common, action: "hide-start", receipt: baseReceipt, evidence })
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "HideTemporarily", args: ["C1", evidence.sha256, cid], send: "" })
        readAccess.mockResolvedValueOnce({ isManager: false, creator: founder })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        getReceipt.mockResolvedValueOnce({ ...baseReceipt, hidden: true, hold: { ...hold, actor: manager } })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
    })

    it("requires a second live manager and verifies a confirmed hold", async () => {
        const receipt = { ...baseReceipt, hidden: true, hold }
        getReceipt.mockResolvedValue(receipt)
        const req = editorialRequest({ ...common, action: "hide-confirm", receipt })
        expect(req.prepare(undefined).msgs[0].value).toMatchObject({ func: "ConfirmHide", args: ["C1"] })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        getReceipt.mockResolvedValueOnce({ ...receipt, hold: { ...hold, confirmer: manager } })
        await expect(req.verify?.(undefined, "tx", null)).resolves.toBe(true)
        expect(() => editorialRequest({ ...common, action: "hide-confirm", receipt: { ...receipt,
            hold: { ...hold, actor: manager } } })).toThrow("not ready")
    })

    it("allows a current manager to hold a collection with no founder application", async () => {
        getApplication.mockResolvedValue(null)
        const req = editorialRequest({ ...common, application: null, action: "hide-start", receipt: baseReceipt, evidence })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        getApplication.mockResolvedValueOnce(application)
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
    })
})

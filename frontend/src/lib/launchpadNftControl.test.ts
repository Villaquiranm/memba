import { beforeEach, describe, expect, it, vi } from "vitest"
import { packageAddress } from "./dao/weightedApplications"
import { getLaunchpadNftCollection, getLaunchpadNftToken } from "./launchpadNft"
import { buildNftControlMsg, nftControlRequest, readNftControlState, type NftControlState } from "./launchpadNftControl"

vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn(), getLaunchpadNftToken: vi.fn() }))

const holder = packageAddress("gno.land/r/samcrew/person/holder")
const recipient = packageAddress("gno.land/r/samcrew/person/recipient")
const creator = packageAddress("gno.land/r/samcrew/person/creator")
const open = { collection: { id: "C1", name: "Civic Art", creator, mode: "open", revocable: false, minted: 2n },
    token: { collection: "C1", number: 2n, owner: holder, status: "active", soulbound: false, uri: "ipfs://art/2.json" } } as NftControlState
const soulbound = { collection: { ...open.collection, mode: "soulbound", revocable: true },
    token: { ...open.token, soulbound: true } } as NftControlState

describe("native NFT token controls", () => {
    beforeEach(() => vi.resetAllMocks())

    it("checks collection and token identity before showing controls", async () => {
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(open.collection)
        vi.mocked(getLaunchpadNftToken).mockResolvedValue(open.token)
        await expect(readNftControlState("rpc", "C1", 2n)).resolves.toEqual(open)
        vi.mocked(getLaunchpadNftToken).mockResolvedValueOnce({ ...open.token, soulbound: true })
        await expect(readNftControlState("rpc", "C1", 2n)).rejects.toThrow("inconsistent")
    })

    it("restricts Open transfer to its owner and refuses Soulbound transfers", () => {
        expect(buildNftControlMsg(open, holder, { kind: "transfer", recipient }).value).toMatchObject({
            caller: holder, send: "", func: "Transfer", args: ["C1", holder, recipient, "2"],
        })
        expect(() => buildNftControlMsg(open, creator, { kind: "transfer", recipient })).toThrow("owner")
        expect(() => buildNftControlMsg(soulbound, holder, { kind: "transfer", recipient })).toThrow("Open")
        expect(() => buildNftControlMsg(open, holder, { kind: "transfer", recipient: holder })).toThrow("different")
    })

    it("allows holder burn and creator revocation only under fixed Soulbound rights", () => {
        expect(buildNftControlMsg(soulbound, holder, { kind: "burn" }).value.func).toBe("Burn")
        expect(buildNftControlMsg(soulbound, creator, { kind: "revoke", reason: "expired" }).value).toMatchObject({
            send: "", func: "Revoke", args: ["C1", "2", "expired"],
        })
        expect(() => buildNftControlMsg(soulbound, holder, { kind: "revoke", reason: "expired" })).toThrow("authorized")
        expect(() => buildNftControlMsg(open, creator, { kind: "revoke", reason: "expired" })).toThrow("Soulbound")
    })

    it("rechecks authority and verifies transfer and permanent retirement", async () => {
        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(open.collection)
        vi.mocked(getLaunchpadNftToken).mockResolvedValue(open.token)
        const transfer = nftControlRequest({ state: open, caller: holder, action: { kind: "transfer", recipient },
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        await expect(transfer.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(getLaunchpadNftToken).mockResolvedValueOnce({ ...open.token, owner: recipient })
        await expect(transfer.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadNftToken).mockResolvedValueOnce({ ...open.token, owner: recipient })
        await expect(transfer.verify?.(undefined, "hash", undefined)).resolves.toBe(true)

        vi.mocked(getLaunchpadNftCollection).mockResolvedValue(soulbound.collection)
        vi.mocked(getLaunchpadNftToken).mockResolvedValue({ ...soulbound.token, status: "revoked", owner: "" })
        const revoke = nftControlRequest({ state: soulbound, caller: creator, action: { kind: "revoke", reason: "expired" },
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 50000 })
        await expect(revoke.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { getLaunchpadMarketOffer, type LaunchpadMarketOffer } from "./launchpadMarket"
import { buildOfferExitMsg, offerExitRequest } from "./launchpadOfferExit"

vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketOffer: vi.fn() }))

const buyer = `g1${"p".repeat(38)}`
const helper = `g1${"q".repeat(38)}`
const offer: LaunchpadMarketOffer = {
    id: "O8", collection: "C7", number: 3n, buyer, price: 9007199254740993n,
    currency: "ugnot", expiresAt: 2000000000n, createdAt: 100n, configVersion: 4n,
    protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active",
}

describe("funded offer exits", () => {
    beforeEach(() => vi.resetAllMocks())

    it("restricts cancellation to the buyer and permissionless expiry to the deadline", () => {
        expect(buildOfferExitMsg(offer, buyer, "cancel", 1000)).toEqual({ type: "vm/MsgCall", value: {
            caller: buyer, send: "", pkg_path: "gno.land/r/samcrew/launchpad/market/v1",
            func: "CancelOffer", args: ["O8"], max_deposit: "1000000ugnot",
        } })
        expect(() => buildOfferExitMsg(offer, helper, "cancel", 1000)).toThrow("not ready")
        expect(() => buildOfferExitMsg(offer, helper, "expire", 1000)).toThrow("not ready")
        const expiry = buildOfferExitMsg(offer, helper, "expire", Number(offer.expiresAt))
        expect(expiry).toMatchObject({ value: { caller: helper, send: "", func: "ExpireOffer", args: ["O8"] } })
        expect(grc20.toAdenaMessages([expiry])[0]).toMatchObject({ type: "/vm.m_call", value: { func: "ExpireOffer", args: ["O8"] } })
    })

    it("shows the original buyer as the refund recipient even when someone else pays gas", () => {
        const expired = { ...offer, expiresAt: 1000n }
        const req = offerExitRequest({ offer: expired, caller: helper, action: "expire", rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        expect(req.lines(undefined)).toContainEqual(["Refund recipient", buyer])
        expect(req.lines(undefined)).toContainEqual(["Full refund", `${offer.price.toLocaleString()} ugnot`])
        expect(req.warns?.join(" ")).toContain("caller pays gas")
    })

    it("stops on changed offer terms and confirms only the matching terminal status", async () => {
        const req = offerExitRequest({ offer, caller: buyer, action: "cancel", rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, price: offer.price + 1n })
        await expect(req.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce(offer)
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, status: "accepted" })
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
        vi.mocked(getLaunchpadMarketOffer).mockResolvedValueOnce({ ...offer, status: "cancelled" })
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })

    it("broadcasts exactly one no-payment refund call without retry", async () => {
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const req = offerExitRequest({ offer, caller: buyer, action: "cancel", rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        const beforeSign = vi.fn()
        await req.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([req.prepare(undefined).msgs[0]], "Cancel offer O8",
            { gasWanted: 50_000_000, retry: false, beforeSign })
    })
})

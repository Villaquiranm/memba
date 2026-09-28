import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { getLaunchpadMarketListing, getLaunchpadMarketQuote, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady,
    type LaunchpadMarketListing, type LaunchpadMarketQuote } from "./launchpadMarket"
import { APPROVE_WUGNOT_GAS_WANTED, MARKET_SPENDER, WUGNOT_KEY, WUGNOT_REALM,
    approveWugnotRequest, buildApproveWugnotMsg, buildBuyWugnotMsg, buyWugnotRequest,
    parseWugnotSpend, readWugnotSpend, type WugnotSpend } from "./launchpadTokenTrade"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketListing: vi.fn(), getLaunchpadMarketQuote: vi.fn(),
    getLaunchpadMarketTokenOwner: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn() }))

const buyer = `g1${"p".repeat(38)}`
const seller = `g1${"q".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86400)
const listing: LaunchpadMarketListing = { id: "L3", collection: "C4", number: 1n, seller, price: 1000n,
    currency: WUGNOT_KEY, expiresAt, createdAt: 100n, configVersion: 2n,
    protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" }
const quote: LaunchpadMarketQuote = { listing: "L3", price: 1000n, currency: WUGNOT_KEY,
    sellerAmount: 945n, protocolAmount: 5n, royaltyTotal: 50n, treasury,
    currentConfigVersion: 4n, executable: true, royalties: [{ account: artist, amount: 50n }] }
const spend: WugnotSpend = { currency: WUGNOT_KEY, owner: buyer, spender: MARKET_SPENDER,
    name: "wrapped GNOT", symbol: "wugnot", decimals: 0, balance: 11000n, allowance: 0n }
const qeval = (value: unknown) => `(${JSON.stringify(JSON.stringify(value))} string)`
const record = (allowance: string) => ({ currency: WUGNOT_KEY, owner: buyer, spender: MARKET_SPENDER,
    name: "wrapped GNOT", symbol: "wugnot", decimals: "0", balance: "11000", allowance })

function fresh(allowance = "0") {
    vi.mocked(getLaunchpadMarketListing).mockResolvedValue(listing)
    vi.mocked(getLaunchpadMarketQuote).mockResolvedValue(quote)
    vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValue(buyer)
    vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValue(true)
    vi.mocked(queryEval).mockResolvedValue(qeval(record(allowance)))
}

describe("WUGNOT NFT purchases", () => {
    beforeEach(() => vi.resetAllMocks())

    it("reads the registered token and exact market spender without rounding", async () => {
        fresh("9007199254740993")
        expect(MARKET_SPENDER).toBe("g1nn54k5fmly8agexe3ll4t6clqmcefsn7nr9ee3")
        await expect(readWugnotSpend("rpc", buyer)).resolves.toMatchObject({ allowance: 9007199254740993n, decimals: 0 })
        expect(queryEval).toHaveBeenCalledWith("rpc", "gno.land/r/samcrew/launchpad/market/v1",
            `TokenSpendJSON("${WUGNOT_KEY}", "${buyer}")`, true)
        expect(() => parseWugnotSpend({ ...record("1000"), spender: seller }, buyer)).toThrow("identity")
        expect(() => parseWugnotSpend({ ...record("1000"), balance: "-1" }, buyer)).toThrow("amount")
    })

    it("approves exactly one listing price with no payment", async () => {
        fresh()
        expect(buildApproveWugnotMsg(spend, 1000n)).toEqual({ type: "vm/MsgCall", value: {
            caller: buyer, send: "", pkg_path: WUGNOT_REALM, func: "Approve",
            args: [MARKET_SPENDER, "1000"], max_deposit: "1000000ugnot" } })
        expect(() => buildApproveWugnotMsg({ ...spend, balance: 999n }, 1000n)).toThrow("unavailable")
        const request = approveWugnotRequest({ listing, spend, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockResolvedValueOnce(qeval(record("1000")))
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const beforeSign = vi.fn()
        await request.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([request.prepare(undefined).msgs[0]], expect.any(String),
            { gasWanted: APPROVE_WUGNOT_GAS_WANTED, retry: false, beforeSign })
    })

    it("rejects a changed listing or policy before approval", async () => {
        fresh()
        const request = approveWugnotRequest({ listing, spend, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce({ ...listing, price: 1001n })
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValueOnce(false)
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
    })

    it("buys under the exact allowance and payout split without attached coins", async () => {
        fresh("1000")
        const approved = { ...spend, allowance: 1000n }
        expect(buildBuyWugnotMsg(listing, quote, approved)).toEqual({ type: "vm/MsgCall", value: {
            caller: buyer, send: "", pkg_path: "gno.land/r/samcrew/launchpad/market/v1", func: "Buy",
            args: ["L3", "4"], max_deposit: "5000000ugnot" } })
        expect(() => buildBuyWugnotMsg(listing, quote, spend)).toThrow("not ready")
        expect(() => buildBuyWugnotMsg(listing, { ...quote, protocolAmount: 6n }, approved)).toThrow("not ready")
        const request = buyWugnotRequest({ listing, quote, spend: approved, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockResolvedValueOnce(qeval(record("999")))
        await expect(request.recheck?.(undefined)).rejects.toThrow("not ready")
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce({ ...listing, status: "filled" })
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        expect(request.lines(undefined)).toContainEqual(["DAO treasury", treasury])
    })
})

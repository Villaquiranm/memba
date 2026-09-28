import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { getLaunchpadNftCollection } from "./launchpadNft"
import { getLaunchpadMarketListing, getLaunchpadMarketTokenOwner, isLaunchpadMarketPolicyReady } from "./launchpadMarket"
import { APPROVE_GAS_WANTED, MARKET_OPERATOR, approveListingRequest, buildApproveListingMsg, buildCreateListingMsg,
    createListingRequest, formatGnotPrice, parseGnotPrice, readListingReadiness, type ListingReadiness } from "./launchpadListing"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))
vi.mock("./launchpadNft", () => ({ getLaunchpadNftCollection: vi.fn() }))
vi.mock("./launchpadMarket", () => ({ getLaunchpadMarketListing: vi.fn(), getLaunchpadMarketTokenOwner: vi.fn(), isLaunchpadMarketPolicyReady: vi.fn() }))

const seller = `g1${"p".repeat(38)}`
const artist = `g1${"a".repeat(38)}`
const collection = { id: "C7", name: "Art", mode: "open", tradable: true, royaltyBPS: 500n,
    royalties: [{ account: artist, bps: 500n }] } as never
const readiness: ListingReadiness = {
    collection, number: 3n, owner: seller, approved: true, approvalScope: "token", currentListingID: "",
    configVersion: 4n, feeBPS: 50n, policyReady: true,
}

function mockRead(approved = true) {
    vi.mocked(getLaunchpadNftCollection).mockResolvedValue(collection)
    vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValue(seller)
    vi.mocked(isLaunchpadMarketPolicyReady).mockResolvedValue(true)
    vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => {
        if (expr === "GetCurrentVersion()") return "(4 int64)"
        if (expr === "GetVersion(4).NFTSecondaryFeeBPS") return "(50 int64)"
        if (expr.startsWith("MarketApprovalJSON(")) return `(${JSON.stringify(JSON.stringify({
            collection: "C7", number: "3", owner: seller, operator: MARKET_OPERATOR,
            tokenApproved: approved, collectionApproved: false,
        }))} string)`
        if (expr.startsWith("CurrentListingID(")) return '("" string)'
        throw new Error(`Unexpected query: ${expr}`)
    })
}

describe("Launchpad seller listing", () => {
    beforeEach(() => vi.resetAllMocks())

    it("targets the deployed market package address derived from the realm path", () => {
        expect(MARKET_OPERATOR).toBe("g1nn54k5fmly8agexe3ll4t6clqmcefsn7nr9ee3")
    })

    it("parses exact GNOT prices without precision loss or scientific notation", () => {
        expect(parseGnotPrice("1.25")).toBe(1_250_000n)
        expect(parseGnotPrice("0.000001")).toBe(1n)
        expect(parseGnotPrice("9007199254.740993")).toBe(9007199254740993n)
        expect(formatGnotPrice(1_250_000n)).toBe("1.25 GNOT")
        expect(formatGnotPrice(9_007_199_254_740_993n)).toBe("9,007,199,254.740993 GNOT")
        for (const value of ["0", "1.0000001", "1e3", "01", "-1", "9223372036855"]) expect(() => parseGnotPrice(value)).toThrow()
    })

    it("reads ownership, exact approval, policy version and fee from chain", async () => {
        mockRead()
        const actual = await readListingReadiness("rpc", "C7", 3n, seller)
        expect(actual).toMatchObject({ owner: seller, approved: true, approvalScope: "token", configVersion: 4n, feeBPS: 50n, policyReady: true })
        expect(queryEval).toHaveBeenCalledWith("rpc", expect.any(String), "GetVersion(4).NFTSecondaryFeeBPS", true)
    })

    it("builds one exact-token approval and rejects owners who no longer hold the NFT", async () => {
        mockRead(false)
        const unapproved = await readListingReadiness("rpc", "C7", 3n, seller)
        const msg = buildApproveListingMsg(unapproved)
        expect(msg).toMatchObject({ type: "vm/MsgCall", value: {
            caller: seller, send: "", func: "Approve", args: ["C7", MARKET_OPERATOR, "3"], max_deposit: "1000000ugnot",
        } })
        expect(grc20.toAdenaMessages([msg])[0]).toMatchObject({ type: "/vm.m_call", value: { func: "Approve", args: ["C7", MARKET_OPERATOR, "3"] } })
        const req = approveListingRequest({ readiness: unapproved, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        expect(req.lines(undefined)).toContainEqual(["Approval scope", "This token only"])
        expect(APPROVE_GAS_WANTED).toBe(50_000_000)
        vi.mocked(getLaunchpadMarketTokenOwner).mockResolvedValueOnce(artist)
        await expect(req.recheck?.(undefined)).rejects.toThrow("not owned")
    })

    it("builds a lossless List call and reviews seller, DAO and creator payouts", () => {
        const now = 1_000_000n
        const price = 9_007_199_254_740_993n
        const msg = buildCreateListingMsg(readiness, price, now + 86400n, now)
        expect(msg).toMatchObject({ value: { caller: seller, send: "", func: "List",
            args: ["C7", "3", price.toString(), (now + 86400n).toString(), "ugnot", "4"], max_deposit: "5000000ugnot" } })
        const req = createListingRequest({ readiness, price, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400),
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        const lines = req.lines(undefined)
        expect(lines).toContainEqual(["DAO fee", `${(price * 50n / 10_000n).toLocaleString()} ugnot (50 bps)`])
        expect(lines).toContainEqual(["Creator royalties", `${(price * 500n / 10_000n).toLocaleString()} ugnot`])
        expect(buildCreateListingMsg({ ...readiness, currentListingID: "L1" }, price, now + 86400n, now)).toMatchObject({ value: { func: "List" } })
        const replacement = createListingRequest({ readiness: { ...readiness, currentListingID: "L1" }, price,
            expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86400), rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        expect(replacement.acks).toContain("I understand this replaces the existing listing.")
        expect(() => buildCreateListingMsg({ ...readiness, policyReady: false }, price, now + 86400n, now)).toThrow("not ready")
    })

    it("rechecks fee and existing listing, then confirms only matching on-chain terms", async () => {
        mockRead()
        const price = 1_250_000n
        const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86400)
        const req = createListingRequest({ readiness, price, expiresAt, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(req.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => expr === "GetCurrentVersion()" ? "(5 int64)" : "(false bool)")
        await expect(req.recheck?.(undefined)).rejects.toThrow()
        vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => expr.startsWith("CurrentListingID(") ? '("L9" string)' : "(4 int64)")
        vi.mocked(getLaunchpadMarketListing).mockResolvedValue({ id: "L9", collection: "C7", number: 3n, seller,
            price, currency: "ugnot", expiresAt, configVersion: 4n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        vi.mocked(getLaunchpadMarketListing).mockResolvedValueOnce({ id: "L9", collection: "C7", number: 3n, seller,
            price: price + 1n, currency: "ugnot", expiresAt, configVersion: 4n, protocolFeeBPS: 50n, royaltyBPS: 500n, status: "active" } as never)
        await expect(req.verify?.(undefined, "hash", undefined)).resolves.toBe(false)
    })
})

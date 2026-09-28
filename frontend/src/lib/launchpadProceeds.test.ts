import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { buildProceedsClaimMsg, claimNativeProceedsRequest, claimProceedsRequest, readCurrencyProceeds, readNativeProceeds, proceedsClaimScope,
    type ProceedsCurrency } from "./launchpadProceeds"
import { WUGNOT_KEY } from "./launchpadTokenTrade"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))

const treasury = `g1${"t".repeat(38)}`
const member = `g1${"p".repeat(38)}`

function mockReads(treasuryAmount = 500n, memberAmount = 100n, currency: ProceedsCurrency = "ugnot") {
    vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => {
        if (expr === "GetCurrentVersion()") return "(4 int64)"
        if (expr === "CurrentTreasuryAddress()") return `("${treasury}" string)`
        if (expr === `LiabilityOf("${currency}")`) return "(1000 int64)"
        if (expr === `ClaimableOfAddress("${currency}", "${treasury}")`) return `(${treasuryAmount} int64)`
        if (expr === `ClaimableOfAddress("${currency}", "${member}")`) return `(${memberAmount} int64)`
        throw new Error(`Unexpected query: ${expr}`)
    })
}

describe("native Launchpad proceeds", () => {
    beforeEach(() => vi.resetAllMocks())

    it("reads DAO and member claimable balances with stable policy", async () => {
        mockReads()
        await expect(readNativeProceeds("rpc", member)).resolves.toEqual({ configVersion: 4n, treasury,
            treasuryClaimable: 500n, member, memberClaimable: 100n, totalLiability: 1000n })
        await expect(readNativeProceeds("rpc", null)).resolves.toMatchObject({ member: null, memberClaimable: null })
        expect(queryEval).toHaveBeenCalledWith("rpc", "gno.land/r/samcrew/launchpad/fees/v1",
            `ClaimableOfAddress("ugnot", "${treasury}")`, true)
    })

    it("rejects malformed or impossible proceeds and a changed version", async () => {
        mockReads(1001n)
        await expect(readNativeProceeds("rpc", member)).rejects.toThrow("changed")
        mockReads()
        vi.mocked(queryEval).mockImplementationOnce(async () => "(4 int64)")
            .mockImplementationOnce(async () => '("not-an-address" string)')
        await expect(readNativeProceeds("rpc", member)).rejects.toThrow("treasury")
    })

    it("reviews a direct caller claim with no sent payment and no retry", async () => {
        mockReads()
        const msg = buildProceedsClaimMsg(member, 100n)
        expect(msg).toEqual({ type: "vm/MsgCall", value: { caller: member, send: "",
            pkg_path: "gno.land/r/samcrew/launchpad/fees/v1", func: "Claim", args: ["ugnot"], max_deposit: "1000000ugnot" } })
        const request = claimNativeProceedsRequest({ caller: member, amount: 100n, rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockResolvedValueOnce("(101 int64)")
        await expect(request.recheck?.(undefined)).rejects.toThrow("changed")
        vi.mocked(queryEval).mockResolvedValueOnce("(0 int64)")
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
        const broadcast = vi.spyOn(grc20, "doContractBroadcast").mockResolvedValue({ hash: "hash" })
        const beforeSign = vi.fn()
        await request.send(undefined, beforeSign)
        expect(broadcast).toHaveBeenCalledWith([msg], "Claim Launchpad proceeds", { gasWanted: 50_000_000, retry: false, beforeSign })
    })

    it("reads and claims WUGNOT credits with a distinct receipt scope", async () => {
        mockReads(50n, 10n, WUGNOT_KEY)
        await expect(readCurrencyProceeds("rpc", member, WUGNOT_KEY)).resolves.toMatchObject({
            treasuryClaimable: 50n, memberClaimable: 10n, totalLiability: 1000n,
        })
        expect(proceedsClaimScope("gnoland1", member, WUGNOT_KEY).operation).toBe(`claim:${WUGNOT_KEY}`)
        const request = claimProceedsRequest({ caller: member, amount: 10n, currency: WUGNOT_KEY,
            rpcUrl: "rpc", chainId: "gnoland1", estimatedGasFeeUgnot: 60000 })
        expect(request.prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: member, send: "", func: "Claim", args: [WUGNOT_KEY],
        } })
        expect(request.lines(undefined)).toContainEqual(["Claimed amount", "10 wugnot"])
        await expect(request.recheck?.(undefined)).resolves.toBeUndefined()
        vi.mocked(queryEval).mockResolvedValueOnce("(0 int64)")
        await expect(request.verify?.(undefined, "hash", undefined)).resolves.toBe(true)
    })
})

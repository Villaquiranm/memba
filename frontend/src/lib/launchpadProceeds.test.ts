import { beforeEach, describe, expect, it, vi } from "vitest"
import * as grc20 from "./grc20"
import { queryEval } from "./dao/shared"
import { buildProceedsClaimMsg, claimNativeProceedsRequest, readNativeProceeds } from "./launchpadProceeds"

vi.mock("./dao/shared", async (original) => ({ ...(await original<typeof import("./dao/shared")>()), queryEval: vi.fn() }))

const treasury = `g1${"t".repeat(38)}`
const member = `g1${"p".repeat(38)}`

function mockReads(treasuryAmount = 500n, memberAmount = 100n) {
    vi.mocked(queryEval).mockImplementation(async (_rpc, _path, expr) => {
        if (expr === "GetCurrentVersion()") return "(4 int64)"
        if (expr === "CurrentTreasuryAddress()") return `("${treasury}" string)`
        if (expr === 'LiabilityOf("ugnot")') return "(1000 int64)"
        if (expr === `ClaimableOfAddress("ugnot", "${treasury}")`) return `(${treasuryAmount} int64)`
        if (expr === `ClaimableOfAddress("ugnot", "${member}")`) return `(${memberAmount} int64)`
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
})

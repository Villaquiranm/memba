import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import LaunchpadCreatorStudio from "./studio"

const getCollection = vi.hoisted(() => vi.fn())
const readStages = vi.hoisted(() => vi.fn())
const readTerms = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadNft", () => ({ getLaunchpadNftCollection: getCollection }))
vi.mock("../../../lib/launchpadDropStages", async (original) => ({
    ...(await original<typeof import("../../../lib/launchpadDropStages")>()), readFixedDropStages: readStages,
}))
vi.mock("../../../lib/launchpadActionTerms", async (original) => ({
    ...(await original<typeof import("../../../lib/launchpadActionTerms")>()), readActionTerms: readTerms,
}))
vi.mock("../../../lib/grc20", async (original) => ({
    ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })),
}))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const creator = `g1${"p".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const session = { status: "member", address: creator, network: { key: "testnet12", chainId: "test12" }, openConnect: vi.fn() } as never
const terms = { lane: "drops", currency: "ugnot", version: 3n, treasury, collectionFee: 0n, primaryFeeBPS: 200n,
    currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true }

function localDate(offsetHours: number): string {
    const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000)
    const pad = (number: number) => String(number).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe("native Launchpad Creator Studio", () => {
    beforeEach(() => { getCollection.mockReset(); readStages.mockReset(); readTerms.mockReset(); sign.mockReset(); localStorage.clear() })

    it("gates unpublished drops and reads creator authority before showing scheduling", async () => {
        const view = render(<LaunchpadCreatorStudio rpcUrl="rpc" session={session} available={false} toast={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaits the reviewed NFT")
        view.rerender(<LaunchpadCreatorStudio rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        getCollection.mockResolvedValue({ id: "C1", name: "Founders", creator: `g1${"q".repeat(38)}`, mode: "soulbound", minted: 0n, maxSupply: 100n })
        readStages.mockResolvedValue([]); readTerms.mockResolvedValue(terms)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.click(screen.getByRole("button", { name: "Load collection and stages" }))
        expect(await screen.findByText(/This wallet is not the on-chain creator/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Review fixed-price stage" })).toBeNull()
    })

    it("reviews a native fixed-price stage with exact UTC, DAO fee and no payment", async () => {
        getCollection.mockResolvedValue({ id: "C1", name: "Founders", creator, mode: "soulbound", minted: 0n, maxSupply: 100n })
        readStages.mockResolvedValue([]); readTerms.mockResolvedValue(terms)
        render(<LaunchpadCreatorStudio rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.click(screen.getByRole("button", { name: "Load collection and stages" }))
        expect(await screen.findByText(/Soulbound · recipients claim their own tokens/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Start · local time"), { target: { value: localDate(2) } })
        fireEvent.change(screen.getByLabelText("End · local time"), { target: { value: localDate(4) } })
        fireEvent.change(screen.getByLabelText("Mint price in GNOT"), { target: { value: "1.25" } })
        fireEvent.change(screen.getByLabelText("Stage supply cap"), { target: { value: "100" } })
        fireEvent.change(screen.getByLabelText("Per-wallet limit"), { target: { value: "2" } })
        fireEvent.click(screen.getByRole("button", { name: "Review fixed-price stage" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: creator, send: "", func: "AddFixedStage", args: ["C1", expect.any(String), expect.any(String), "1250000", "100", "2", "ugnot", "3"],
        } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["DAO primary fee", "200 bps from the mint price"])
    })

    it("reviews a creator's price change before the original stage begins", async () => {
        const now = BigInt(Math.floor(Date.now() / 1000))
        getCollection.mockResolvedValue({ id: "C1", name: "Founders", creator, mode: "open", minted: 0n, maxSupply: 100n })
        readStages.mockResolvedValue([{ collection: "C1", index: 0, start: now + 7200n, end: now + 14400n,
            price: 1_000_000n, currency: "ugnot", supplyCap: 100n, perWallet: 2n, minted: 0n }])
        readTerms.mockResolvedValue(terms)
        render(<LaunchpadCreatorStudio rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.click(screen.getByRole("button", { name: "Load collection and stages" }))
        fireEvent.click(await screen.findByRole("button", { name: "Review or edit stage 1" }))
        fireEvent.change(screen.getByLabelText("Mint price in GNOT"), { target: { value: "2" } })
        fireEvent.click(screen.getByRole("button", { name: "Review stage changes" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: creator, send: "", func: "EditFixedStage",
            args: ["C1", "0", expect.any(String), expect.any(String), "2000000", "100", "2", "ugnot", "3"],
        } })
    })
})

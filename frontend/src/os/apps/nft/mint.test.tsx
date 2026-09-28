import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MintLaunchpadNFT from "./mint"

const readMint = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadPrimaryMint", async (original) => ({
    ...(await original<typeof import("../../../lib/launchpadPrimaryMint")>()), readNativeMintReadiness: readMint,
}))
vi.mock("../../../lib/grc20", async (original) => ({
    ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })),
}))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const buyer = `g1${"p".repeat(38)}`
const creator = `g1${"c".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const session = { status: "member", address: buyer, network: { key: "testnet12", chainId: "test12" }, openConnect: vi.fn() } as never
const now = BigInt(Math.floor(Date.now() / 1000))
const readiness = { buyer, collection: { id: "C1", name: "Founders", creator, mode: "soulbound", revocable: true,
    revealed: true, minted: 1n, maxSupply: 100n },
stage: { collection: "C1", index: 0, start: now - 3600n, end: now + 3600n,
    price: 1_250_000n, currency: "ugnot", supplyCap: 100n, perWallet: 2n, minted: 0n },
claimed: 0n, terms: { lane: "drops", currency: "ugnot", version: 3n, treasury, collectionFee: 0n,
    primaryFeeBPS: 200n, currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true } }

describe("native primary mint view", () => {
    beforeEach(() => { readMint.mockReset(); sign.mockReset(); localStorage.clear() })

    it("gates unpublished realms", () => {
        render(<MintLaunchpadNFT rpcUrl="rpc" session={session} available={false} toast={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaits the reviewed NFT")
        expect(readMint).not.toHaveBeenCalled()
    })

    it("shows exact payout and reviews a recipient-claimed Soulbound mint", async () => {
        readMint.mockResolvedValue(readiness)
        render(<MintLaunchpadNFT rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.change(screen.getByLabelText("Stage number"), { target: { value: "1" } })
        fireEvent.click(screen.getByRole("button", { name: "Check mint eligibility" }))
        expect(await screen.findByText(/Soulbound · your wallet claims/)).toBeInTheDocument()
        expect(screen.getByText(/Creator credit 1.225 GNOT · DAO fee 0.025 GNOT/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Review Soulbound claim" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: buyer, send: "1250000ugnot", func: "MintFixed", args: ["C1", "0", "3"],
        } })
    })

    it("disables wallet action for a sold-out stage", async () => {
        readMint.mockResolvedValue({ ...readiness, stage: { ...readiness.stage, minted: 100n } })
        render(<MintLaunchpadNFT rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        fireEvent.change(screen.getByLabelText("Collection ID"), { target: { value: "C1" } })
        fireEvent.change(screen.getByLabelText("Stage number"), { target: { value: "1" } })
        fireEvent.click(screen.getByRole("button", { name: "Check mint eligibility" }))
        expect(await screen.findByText(/closed, sold out/)).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Review Soulbound claim" })).toBeDisabled()
    })
})

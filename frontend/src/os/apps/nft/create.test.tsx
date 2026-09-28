import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { packageAddress } from "../../../lib/dao/weightedApplications"
import CreateLaunchpadCollection from "./create"

const readActionTerms = vi.hoisted(() => vi.fn())
const sign = vi.hoisted(() => vi.fn())
const gasPrice = vi.hoisted(() => vi.fn(async () => ({ gas: 1000, ugnot: 1 })))
vi.mock("../../../lib/launchpadActionTerms", async (original) => ({ ...(await original<typeof import("../../../lib/launchpadActionTerms")>()), readActionTerms }))
vi.mock("../../../lib/grc20", async (original) => ({ ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: gasPrice }))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const creator = `g1${"p".repeat(38)}`
const treasury = `g1${"t".repeat(38)}`
const session = { status: "member", address: creator, network: { key: "testnet12", chainId: "test12" }, openConnect: vi.fn() } as never
const terms = { lane: "collection", currency: "ugnot", version: 2n, treasury, collectionFee: 40n,
    primaryFeeBPS: 100n, currencyConfigured: true, currencyAllowed: true, paused: false, laneReady: true, actionReady: true }

describe("native Launchpad creator form", () => {
    beforeEach(() => { readActionTerms.mockReset(); sign.mockReset(); localStorage.clear() })

    it("gates unpublished creation realms", () => {
        render(<CreateLaunchpadCollection rpcUrl="rpc" session={session} available={false} toast={vi.fn()} />)
        expect(screen.getByRole("note")).toHaveTextContent("awaits the reviewed Launchpad")
        expect(readActionTerms).not.toHaveBeenCalled()
    })

    it("shows the DAO fee and reviews one static Soulbound creation", async () => {
        readActionTerms.mockResolvedValue(terms)
        render(<CreateLaunchpadCollection rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        expect(await screen.findByText(/DAO creation fee: 40 ugnot/)).toBeInTheDocument()
        fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "Founders" } })
        fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "fnd" } })
        fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Participation badge" } })
        fireEvent.change(screen.getByLabelText("Ownership mode"), { target: { value: "soulbound" } })
        fireEvent.click(screen.getByLabelText(/creator may revoke issued tokens/i))
        fireEvent.change(screen.getByLabelText("Maximum supply"), { target: { value: "100" } })
        fireEvent.change(screen.getByLabelText("Permanent metadata base URI"), { target: { value: "ipfs://founders/" } })
        fireEvent.click(screen.getByRole("button", { name: "Review collection creation" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: creator, send: "40ugnot", func: "CreateCollection",
            args: ["Founders", "FND", "Participation badge", "", "", "", "soulbound", "true", "100", "ipfs://founders/", "ugnot", "2"],
        } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["DAO treasury", treasury])
    })

    it("reviews an Open reveal commitment with an immutable creator share", async () => {
        readActionTerms.mockResolvedValue(terms)
        render(<CreateLaunchpadCollection rpcUrl="rpc" session={session} available toast={vi.fn()} />)
        await screen.findByText(/DAO creation fee: 40 ugnot/)
        fireEvent.change(screen.getByLabelText("Collection name"), { target: { value: "Revealed Art" } })
        fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "RART" } })
        fireEvent.change(screen.getByLabelText("Maximum supply"), { target: { value: "10" } })
        fireEvent.change(screen.getByLabelText("Metadata plan"), { target: { value: "reveal" } })
        fireEvent.change(screen.getByLabelText("Placeholder JSON URI"), { target: { value: "ipfs://art/placeholder.json" } })
        fireEvent.change(screen.getByLabelText("Base URI SHA-256 commitment"), { target: { value: "a".repeat(64) } })
        fireEvent.change(screen.getByLabelText("Provenance manifest SHA-256"), { target: { value: "b".repeat(64) } })
        fireEvent.click(screen.getByRole("button", { name: "Add royalty receiver" }))
        const receiver = packageAddress("gno.land/r/samcrew/creator/artist")
        fireEvent.change(screen.getByLabelText("Royalty receiver 1"), { target: { value: receiver } })
        fireEvent.change(screen.getByLabelText("Receiver 1 basis points"), { target: { value: "500" } })
        expect(screen.getByText("500 of 1,000 basis points assigned")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Review collection creation" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0]).toMatchObject({ value: {
            caller: creator, send: "40ugnot", func: "CreateCollectionWithRevealAndRoyalties",
            args: ["Revealed Art", "RART", "", "", "", "", "open", "false", "10", "ipfs://art/placeholder.json",
                "a".repeat(64), "b".repeat(64), `${receiver}:500`, "ugnot", "2"],
        } })
        expect(sign.mock.calls[0][0].lines(undefined)).toContainEqual(["Creator royalty", "500 bps · fixed at creation"])
    })
})

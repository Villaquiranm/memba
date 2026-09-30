import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "../../test/test-utils"
import type { Game } from "../../lib/connect4"

const lib = vi.hoisted(() => ({ getActive: vi.fn(), offer: vi.fn(), accept: vi.fn(), cancel: vi.fn(), getGame: vi.fn() }))
vi.mock("../../lib/connect4", async (orig) => ({ ...(await orig<typeof import("../../lib/connect4")>()), ...lib }))

import { Lobby } from "./Lobby"

const base: Game = {
    id: 1, creator: "g1alice", opponent: "", acceptor: "", stake: 2_000_000, fee: 100_000, expiresAt: 2_000,
    commitment: "c".repeat(64), board: "0".repeat(42), turn: 0, turnPlayer: "", moves: 0, lastCol: 0, lastRow: 0,
    deadline: 0, status: "open", winner: "",
}

beforeEach(() => Object.values(lib).forEach((f) => f.mockReset()))

describe("Lobby", () => {
    it("lists offers and lets another player accept", async () => {
        lib.getActive.mockResolvedValue({ now: 1_000, games: [base, { ...base, id: 2, opponent: "g1carol" }] })
        lib.accept.mockResolvedValue({ hash: "h" })
        renderWithProviders(<Lobby me="g1bob" connected onOpen={vi.fn()} />)
        const row1 = await screen.findByRole("row", { name: /#1/ })
        expect(row1).toHaveTextContent("2 GNOT")
        expect(screen.getByRole("row", { name: /#2/ })).toHaveTextContent("private")
        expect(screen.getAllByRole("button", { name: "Accept" })[1]).toBeDisabled() // private, not for bob
        fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[0])
        await waitFor(() => expect(lib.accept).toHaveBeenCalledWith("g1bob", expect.objectContaining({ id: 1 })))
    })

    it("disables Accept on your own and expired offers, and offers Cancel on expired ones to anyone", async () => {
        lib.getActive.mockResolvedValue({ now: 3_000, games: [base] }) // now > expiresAt
        renderWithProviders(<Lobby me="g1bob" connected onOpen={vi.fn()} />)
        const row = await screen.findByRole("row", { name: /#1/ })
        expect(row).toHaveTextContent("expired")
        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled()
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled()
    })

    it("posts an offer, then opens the game found by commitment", async () => {
        lib.getActive.mockResolvedValueOnce({ now: 1_000, games: [] })
        lib.offer.mockResolvedValue("c".repeat(64))
        lib.getActive.mockResolvedValue({ now: 1_001, games: [{ ...base, id: 7 }] })
        const onOpen = vi.fn()
        renderWithProviders(<Lobby me="g1alice" connected onOpen={onOpen} />)
        fireEvent.change(await screen.findByLabelText("Stake (GNOT)"), { target: { value: "2" } })
        fireEvent.change(screen.getByLabelText("Valid for (minutes)"), { target: { value: "15" } })
        fireEvent.click(screen.getByRole("button", { name: "Post offer" }))
        await waitFor(() => expect(lib.offer).toHaveBeenCalledWith("g1alice", { stakeUgnot: 2_000_000, validFor: 15, opponent: "" }))
        await waitFor(() => expect(onOpen).toHaveBeenCalledWith(7))
    })

    it("blocks a stake at or below the fee without signing", async () => {
        lib.getActive.mockResolvedValue({ now: 1_000, games: [] })
        renderWithProviders(<Lobby me="g1alice" connected onOpen={vi.fn()} />)
        fireEvent.change(await screen.findByLabelText("Stake (GNOT)"), { target: { value: "0.5" } })
        expect(screen.getByRole("button", { name: "Post offer" })).toBeDisabled()
    })

    it("asks to connect a wallet before offering", async () => {
        lib.getActive.mockResolvedValue({ now: 1_000, games: [base] })
        renderWithProviders(<Lobby me="" connected={false} onOpen={vi.fn()} />)
        expect(await screen.findByText(/Connect your wallet to play/)).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Post offer" })).toBeNull()
    })
})

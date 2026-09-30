import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "../../test/test-utils"
import type { Game } from "../../lib/connect4"

const lib = vi.hoisted(() => ({
    getGame: vi.fn(), play: vi.fn(), reveal: vi.fn(), resign: vi.fn(), cancel: vi.fn(), claimTimeout: vi.fn(), revealKey: vi.fn(),
}))
vi.mock("../../lib/connect4", async (orig) => ({ ...(await orig<typeof import("../../lib/connect4")>()), ...lib }))

import { GameView } from "./GameView"

const g: Game = {
    id: 4, creator: "g1alice", opponent: "", acceptor: "g1bob", stake: 2_000_000, fee: 100_000, expiresAt: 900,
    commitment: "c".repeat(64), board: "0".repeat(42), turn: 1, turnPlayer: "g1alice", moves: 0, lastCol: 0, lastRow: 0,
    deadline: 1_090, status: "playing", winner: "",
}
const view = (me: string, game: Game, now = 1_000) => {
    lib.getGame.mockResolvedValue({ now, game })
    return renderWithProviders(<GameView id={4} me={me} connected={me !== ""} onBack={vi.fn()} />)
}

beforeEach(() => Object.values(lib).forEach((f) => f.mockReset()))

describe("GameView", () => {
    it("lets the player on turn drop a piece", async () => {
        lib.play.mockResolvedValue({})
        view("g1alice", g)
        expect(await screen.findByText(/Your move/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Drop in column 5" }))
        await waitFor(() => expect(lib.play).toHaveBeenCalledWith("g1alice", 4, 5))
    })

    it("disables the board off-turn and shows Resign", async () => {
        view("g1bob", g)
        expect(await screen.findByText(/Opponent's move/)).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Drop in column 1" })).toBeDisabled()
        expect(screen.getByRole("button", { name: "Resign" })).toBeEnabled()
    })

    it("is read-only for spectators but still offers Claim timeout after the deadline", async () => {
        view("", g, 1_200)
        expect(await screen.findByRole("button", { name: "Claim timeout" })).toBeEnabled()
        expect(screen.queryByRole("button", { name: "Resign" })).toBeNull()
        expect(screen.getByRole("button", { name: "Drop in column 1" })).toBeDisabled()
    })

    it("auto-reveals once for the creator with a stored key", async () => {
        lib.revealKey.mockReturnValue("pass")
        lib.reveal.mockRejectedValue(new Error("reveal clock ran out"))
        view("g1alice", { ...g, turn: 0, turnPlayer: "" })
        await waitFor(() => expect(lib.reveal).toHaveBeenCalledWith("g1alice", 4, "pass"))
        expect(await screen.findByText(/reveal clock ran out/)).toBeInTheDocument()
        await new Promise((r) => setTimeout(r, 50))
        expect(lib.reveal).toHaveBeenCalledTimes(1)
        expect(screen.getByRole("button", { name: "Reveal" })).toBeEnabled() // manual retry
    })

    it("warns the creator when the reveal key is missing", async () => {
        lib.revealKey.mockReturnValue(null)
        view("g1alice", { ...g, turn: 0, turnPlayer: "" })
        expect(await screen.findByText(/reveal key isn't on this device/)).toBeInTheDocument()
        expect(lib.reveal).not.toHaveBeenCalled()
    })

    it("shows the winner and payout when finished", async () => {
        view("g1bob", { ...g, status: "won", winner: "g1bob", turnPlayer: "", deadline: 0 })
        expect(await screen.findByText(/You won 3.9 GNOT/)).toBeInTheDocument()
    })

    it("says not found for an unknown game", async () => {
        lib.getGame.mockResolvedValue({ now: 1, game: null })
        renderWithProviders(<GameView id={4} me="" connected={false} onBack={vi.fn()} />)
        expect(await screen.findByText(/Game #4 not found/)).toBeInTheDocument()
    })
})

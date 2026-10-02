import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderWithProviders } from "../../test/test-utils"

const qp = vi.hoisted(() => ({ startQuickPlay: vi.fn(), quickPlayStatus: vi.fn(), endQuickPlay: vi.fn(), forgetQuickPlay: vi.fn() }))
vi.mock("../../lib/quickPlay", async (orig) => ({ ...(await orig<typeof import("../../lib/quickPlay")>()), ...qp }))
import { QuickPlay } from "./QuickPlay"

beforeEach(() => Object.values(qp).forEach((f) => f.mockReset()))

describe("QuickPlay", () => {
    it("is hidden without a wallet", () => {
        const { container } = renderWithProviders(<QuickPlay me="" connected={false} />)
        expect(container).toBeEmptyDOMElement()
    })
    it("starts a 4h session by default with one approval", async () => {
        qp.quickPlayStatus.mockResolvedValue(null)
        qp.startQuickPlay.mockResolvedValue({ expiresAt: Date.now() / 1000 + 14400, spendUsedUgnot: 0, spendLimitUgnot: 1_000_000 })
        renderWithProviders(<QuickPlay me="g1me" connected />)
        fireEvent.click(await screen.findByRole("button", { name: /Quick play/ }))
        expect(screen.getByRole("button", { name: "4h" })).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByText(/Stakes still ask your wallet/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: /Start · 1 wallet approval/ }))
        await waitFor(() => expect(qp.startQuickPlay).toHaveBeenCalledWith("g1me", 14400))
    })
    it("shows time left and budget when on, and ends or forgets", async () => {
        qp.quickPlayStatus.mockResolvedValue({ expiresAt: Date.now() / 1000 + 3 * 3600 + 12 * 60, spendUsedUgnot: 30_000, spendLimitUgnot: 1_000_000 })
        qp.endQuickPlay.mockResolvedValue(undefined)
        renderWithProviders(<QuickPlay me="g1me" connected />)
        expect(await screen.findByText(/3h 1[12]m left/)).toBeInTheDocument()
        expect(screen.getByText(/0\.97 GNOT/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "End session" }))
        await waitFor(() => expect(qp.endQuickPlay).toHaveBeenCalledWith("g1me"))
        fireEvent.click(screen.getByRole("button", { name: "Forget on this device" }))
        expect(qp.forgetQuickPlay).toHaveBeenCalledWith("g1me")
    })
    it("shows an error note, not the start button, when the status read fails", async () => {
        qp.quickPlayStatus.mockRejectedValue(new Error("network"))
        renderWithProviders(<QuickPlay me="g1me" connected />)
        expect(await screen.findByText("Couldn't read Quick play status")).toBeInTheDocument()
        expect(screen.queryByRole("button", { name: /^⚡ Quick play/ })).toBeNull()
    })
})

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import LaunchpadHoldings from "./holdings"

const fetchHoldings = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/launchpadHoldings", () => ({ fetchLaunchpadHoldings: fetchHoldings }))

const owner = "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const member = { status: "member", address: owner, network: { chainId: "gnoland-1" } } as never

describe("native Launchpad holdings", () => {
    beforeEach(() => fetchHoldings.mockReset())

    it("paginates one indexed snapshot and opens chain-backed token management", async () => {
        fetchHoldings.mockResolvedValueOnce({ chainId: "gnoland-1", indexedHeight: 42,
            items: [{ collection: "C1", number: "1", owner, lastEventBlock: 40 }], nextCursor: "next" })
        fetchHoldings.mockResolvedValueOnce({ chainId: "gnoland-1", indexedHeight: 42,
            items: [{ collection: "C2", number: "2", owner, lastEventBlock: 41 }], nextCursor: "" })
        const open = vi.fn()
        render(<LaunchpadHoldings session={member} open={open} />)
        expect(await screen.findByText("C1 · #1")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Load more collectibles" }))
        expect(await screen.findByText("C2 · #2")).toBeInTheDocument()
        expect(fetchHoldings).toHaveBeenLastCalledWith(owner, "gnoland-1", "next", expect.any(AbortSignal))
        fireEvent.click(screen.getAllByRole("button", { name: "Manage token" })[1])
        expect(open).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({
            kind: "app", app: "nft", section: "manage", query: "collection=C2&number=2",
        }) }))
    })

})

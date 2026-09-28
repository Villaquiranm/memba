import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import RevealCollectionPanel from "./reveal"

const sign = vi.hoisted(() => vi.fn())
vi.mock("../../../lib/grc20", async (original) => ({
    ...(await original<typeof import("../../../lib/grc20")>()), networkGasPrice: vi.fn(async () => ({ gas: 1000, ugnot: 1 })),
}))
vi.mock("../../sign/signerContext", () => ({ useSigner: () => ({ sign, version: 0 }) }))

const creator = `g1${"p".repeat(38)}`
const baseURI = "ipfs://a/"
const collection = { id: "C1", name: "Civic Art", creator, metadataMode: "reveal_base", revealed: false,
    metadataFrozen: false, baseURI: "", baseURICommitment: "7b9747382ecd72ad9efd1a9a871bf3fe8de486d54496c7b027b8add56dc3b690",
    provenanceHash: "b".repeat(64), placeholderURI: "ipfs://placeholder/a.json", minted: 0n } as never
const common = { creator, rpcUrl: "rpc", chainId: "gnoland1", toast: vi.fn(), refresh: vi.fn() }

describe("creator reveal controls", () => {
    beforeEach(() => { sign.mockReset(); common.toast.mockReset(); localStorage.clear() })

    it("checks the committed URI before wallet review", async () => {
        render(<RevealCollectionPanel {...common} collection={collection} />)
        fireEvent.change(screen.getByLabelText("Committed IPFS base URI"), { target: { value: baseURI } })
        expect(screen.getByText(/ipfs:\/\/a\/1.json/)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Review metadata reveal" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0].value).toMatchObject({
            caller: creator, send: "", func: "Reveal", args: ["C1", baseURI],
        })
    })

    it("refuses a mismatched URI and reviews freeze only after reveal", async () => {
        const view = render(<RevealCollectionPanel {...common} collection={collection} />)
        fireEvent.change(screen.getByLabelText("Committed IPFS base URI"), { target: { value: "ipfs://wrong/" } })
        fireEvent.click(screen.getByRole("button", { name: "Review metadata reveal" }))
        await waitFor(() => expect(common.toast).toHaveBeenCalledWith(expect.stringContaining("does not match")))
        expect(sign).not.toHaveBeenCalled()
        view.rerender(<RevealCollectionPanel {...common} collection={{ ...collection, revealed: true, baseURI }} />)
        fireEvent.click(screen.getByRole("button", { name: "Review metadata freeze" }))
        await waitFor(() => expect(sign).toHaveBeenCalledTimes(1))
        expect(sign.mock.calls[0][0].prepare(undefined).msgs[0].value).toMatchObject({
            caller: creator, send: "", func: "FreezeMetadata", args: ["C1"],
        })
    })
})

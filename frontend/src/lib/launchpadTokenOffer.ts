/** Reviewed WUGNOT approval and funded, token-specific NFT offer. */
import { clearGovernanceReceipt } from "./dao/governanceRecovery"
import { doContractBroadcast, type AminoMsg } from "./grc20"
import { getLaunchpadMarketOffer } from "./launchpadMarket"
import { MAKE_OFFER_GAS_WANTED, makeOfferScope, readOfferCount, readOfferReadiness,
    sameOfferReadiness, type OfferReadiness } from "./launchpadOfferTrade"
import { APPROVE_WUGNOT_GAS_WANTED, MARKET_SPENDER, WUGNOT_KEY, WUGNOT_REALM,
    approveWugnotScope, buildApproveWugnotMsg, readWugnotSpend, type WugnotSpend } from "./launchpadTokenTrade"
import { LAUNCHPAD_MARKET_PATH } from "./nftConfig"
import type { SignRequest } from "../os/sign/signer"

const MAX_INT64 = 9223372036854775807n
const MAX_AGE = 90n * 24n * 60n * 60n
const OFFER_STORAGE_CAP = 5_000_000
const APPROVE_STORAGE_CAP = 1_000_000

function offerIdentity(readiness: OfferReadiness, price: bigint, expiresAt: bigint, now: bigint): void {
    if (readiness.currency !== WUGNOT_KEY || !readiness.policyReady ||
        readiness.feeBPS > 200n || readiness.configVersion < 1n ||
        price < 1n || price > MAX_INT64 || expiresAt <= now || expiresAt > now + MAX_AGE) {
        throw new Error("WUGNOT offer is not ready. Refresh its terms.")
    }
}

function approvalScope(chainId: string, readiness: OfferReadiness) {
    return approveWugnotScope(chainId, readiness.buyer,
        `offer:${readiness.collection.id}#${readiness.number.toString()}`)
}

export function approveWugnotOfferRequest(input: {
    readiness: OfferReadiness; price: bigint; expiresAt: bigint; spend: WugnotSpend;
    rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { readiness, price, expiresAt, spend, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    offerIdentity(readiness, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
    if (spend.owner !== readiness.buyer) throw new Error("WUGNOT buyer changed. Refresh.")
    const msg = buildApproveWugnotMsg(spend, price)
    const scope = approvalScope(chainId, readiness)
    const label = `Approve ${price.toLocaleString()} wugnot for NFT offer`
    return {
        title: "Approve exact WUGNOT offer amount", summary: `Allow Market to escrow ${price.toLocaleString()} wugnot from ${readiness.buyer}`,
        lines: () => [["NFT", `${readiness.collection.id} #${readiness.number.toString()}`],
            ["Exact allowance", `${price.toLocaleString()} wugnot`], ["Current balance", `${spend.balance.toLocaleString()} wugnot`],
            ["Market spender", MARKET_SPENDER], ["Token realm", WUGNOT_REALM], ["Network", chainId],
            ["Gas limit", APPROVE_WUGNOT_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${APPROVE_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["Approval does not fund the offer. It permits Market to pull this exact amount only when you sign the separate funded-offer call."],
        acks: ["I checked the token, exact allowance, spender and chain before opening Adena."],
        label: () => label, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const [fresh, freshSpend] = await Promise.all([
                readOfferReadiness(rpcUrl, readiness.collection.id, readiness.number, readiness.buyer, WUGNOT_KEY),
                readWugnotSpend(rpcUrl, readiness.buyer),
            ])
            if (!sameOfferReadiness(readiness, fresh)) throw new Error("NFT or trading policy changed. Refresh before approval.")
            offerIdentity(fresh, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
            buildApproveWugnotMsg(freshSpend, price)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: APPROVE_WUGNOT_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => (await readWugnotSpend(rpcUrl, readiness.buyer)).allowance === price,
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

export function buildMakeWugnotOfferMsg(readiness: OfferReadiness, spend: WugnotSpend,
    price: bigint, expiresAt: bigint, now: bigint): AminoMsg {
    offerIdentity(readiness, price, expiresAt, now)
    if (spend.owner !== readiness.buyer || spend.currency !== WUGNOT_KEY || spend.spender !== MARKET_SPENDER ||
        spend.symbol !== "wugnot" || spend.decimals !== 0 || spend.balance < price || spend.allowance < price) {
        throw new Error("WUGNOT balance or allowance is below the offer price. Refresh.")
    }
    return { type: "vm/MsgCall", value: { caller: readiness.buyer, send: "", pkg_path: LAUNCHPAD_MARKET_PATH,
        func: "MakeOffer", args: [readiness.collection.id, readiness.number.toString(), price.toString(),
            expiresAt.toString(), WUGNOT_KEY, readiness.configVersion.toString()],
        max_deposit: `${OFFER_STORAGE_CAP}ugnot` } }
}

export function makeWugnotOfferRequest(input: {
    readiness: OfferReadiness; spend: WugnotSpend; price: bigint; expiresAt: bigint;
    rpcUrl: string; chainId: string; estimatedGasFeeUgnot: number; onSettled?: () => void
}): SignRequest {
    const { readiness, spend, price, expiresAt, rpcUrl, chainId, estimatedGasFeeUgnot } = input
    if (!Number.isSafeInteger(estimatedGasFeeUgnot) || estimatedGasFeeUgnot <= 0) throw new Error("Could not estimate the network fee.")
    const msg = buildMakeWugnotOfferMsg(readiness, spend, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
    const scope = makeOfferScope(chainId, readiness.buyer, readiness.collection.id, readiness.number, WUGNOT_KEY)
    const label = `Offer on ${readiness.collection.id} #${readiness.number.toString()} with wugnot`
    const protocol = price * readiness.feeBPS / 10_000n
    const royalties = readiness.collection.royalties.map((receiver) => ({ account: receiver.account, amount: price * receiver.bps / 10_000n }))
    const royaltyTotal = royalties.reduce((sum, receiver) => sum + receiver.amount, 0n)
    let baselineCount: bigint | null = null
    return {
        title: "Fund WUGNOT NFT offer", summary: `${price.toLocaleString()} wugnot moves to market escrow`,
        lines: () => [["NFT", `${readiness.collection.id} #${readiness.number.toString()}`], ["Current owner", readiness.owner],
            ["Escrow deposit", `${price.toLocaleString()} wugnot`], ["Market allowance", `${spend.allowance.toLocaleString()} wugnot`],
            ["Seller receives if accepted", `${(price - protocol - royaltyTotal).toLocaleString()} wugnot`],
            ["DAO fee if accepted", `${protocol.toLocaleString()} wugnot (${readiness.feeBPS.toString()} bps)`],
            ["Creator royalties if accepted", `${royaltyTotal.toLocaleString()} wugnot`],
            ...royalties.map((receiver, index): [string, string] => [`Royalty ${index + 1}`, `${receiver.amount.toLocaleString()} wugnot → ${receiver.account}`]),
            ["Expiry", new Date(Number(expiresAt) * 1000).toISOString()], ["Token key", WUGNOT_KEY],
            ["Realm", LAUNCHPAD_MARKET_PATH], ["Network", chainId], ["Gas limit", MAKE_OFFER_GAS_WANTED.toLocaleString()],
            ["Estimated gas fee", `${estimatedGasFeeUgnot.toLocaleString()} ugnot`],
            ["Storage deposit cap", `${OFFER_STORAGE_CAP.toLocaleString()} ugnot`]],
        warns: ["This call sends no native payment. Market pulls the full WUGNOT amount into escrow now. You can cancel an active offer or recover it after expiry.",
            "The DAO fee and creator royalties are pinned now; the DAO treasury receiver is read when the seller accepts."],
        acks: ["I checked the escrow amount, NFT, recipients, expiry and chain before opening Adena."],
        label: () => label, receipt: scope, prepare: () => ({ msgs: [msg] }),
        recheck: async () => {
            const [fresh, freshSpend] = await Promise.all([
                readOfferReadiness(rpcUrl, readiness.collection.id, readiness.number, readiness.buyer, WUGNOT_KEY),
                readWugnotSpend(rpcUrl, readiness.buyer),
            ])
            if (!sameOfferReadiness(readiness, fresh)) throw new Error("NFT or trading policy changed. Refresh before signing.")
            buildMakeWugnotOfferMsg(fresh, freshSpend, price, expiresAt, BigInt(Math.floor(Date.now() / 1000)))
            baselineCount = await readOfferCount(rpcUrl)
        },
        send: (_choice, beforeSign) => doContractBroadcast([msg], label,
            { gasWanted: MAKE_OFFER_GAS_WANTED, retry: false, beforeSign }),
        verify: async () => {
            if (baselineCount === null || await readOfferCount(rpcUrl) !== baselineCount + 1n) return false
            const offer = await getLaunchpadMarketOffer(rpcUrl, `O${(baselineCount + 1n).toString()}`)
            return offer.status === "active" && offer.collection === readiness.collection.id && offer.number === readiness.number &&
                offer.buyer === readiness.buyer && offer.price === price && offer.currency === WUGNOT_KEY &&
                offer.expiresAt === expiresAt && offer.configVersion === readiness.configVersion &&
                offer.protocolFeeBPS === readiness.feeBPS && offer.royaltyBPS === readiness.collection.royaltyBPS
        },
        onSettled: (outcome) => {
            if (outcome === "confirmed") { try { clearGovernanceReceipt(scope) } catch { /* retain conservative lock */ } }
            input.onSettled?.()
        },
    }
}

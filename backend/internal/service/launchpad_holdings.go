package service

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

const maxLaunchpadHoldingsPage = 50

type launchpadHolding struct {
	Collection     string `json:"collection"`
	Number         int64  `json:"number,string"`
	Owner          string `json:"owner"`
	LastEventBlock int64  `json:"lastEventBlock"`
}

type launchpadHoldingsResponse struct {
	ChainID       string             `json:"chainId"`
	IndexedHeight int64              `json:"indexedHeight"`
	Items         []launchpadHolding `json:"items"`
	NextCursor    string             `json:"nextCursor,omitempty"`
}

// HandleLaunchpadHoldings reads only the new chain-scoped event ledger. It
// never combines rows from the legacy NFT portfolio. A client must specify
// the chain it is displaying, and the endpoint is unavailable until indexing
// has started from the realm's exact deployment block.
func HandleLaunchpadHoldings(db *sql.DB, expectedChainID string, enabled bool, indexReady func() bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeHoldingsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !enabled || expectedChainID == "" || indexReady == nil || !indexReady() {
			writeHoldingsError(w, http.StatusServiceUnavailable, "holdings index unavailable")
			return
		}
		q := r.URL.Query()
		owner, requestedChain := q.Get("owner"), q.Get("chain_id")
		if requestedChain != expectedChainID {
			writeHoldingsError(w, http.StatusConflict, "wrong chain")
			return
		}
		if !strings.HasPrefix(owner, "g1") || len(owner) < 10 || len(owner) > 128 || strings.ContainsAny(owner, " \t\r\n") {
			writeHoldingsError(w, http.StatusBadRequest, "invalid owner")
			return
		}
		limit := 20
		if raw := q.Get("limit"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > maxLaunchpadHoldingsPage {
				writeHoldingsError(w, http.StatusBadRequest, "invalid limit")
				return
			}
			limit = parsed
		}
		afterCollection, afterNumber, err := decodeLaunchpadHoldingsCursor(q.Get("cursor"))
		if err != nil {
			writeHoldingsError(w, http.StatusBadRequest, "invalid cursor")
			return
		}

		tx, err := db.BeginTx(r.Context(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			serveHoldingsError(w, err)
			return
		}
		defer func() { _ = tx.Rollback() }()
		var indexedHeight sql.NullInt64
		if err := tx.QueryRowContext(r.Context(), `SELECT MAX(height) FROM launchpad_nft_indexed_blocks
			WHERE chain_id=?`, expectedChainID).Scan(&indexedHeight); err != nil {
			serveHoldingsError(w, err)
			return
		}
		if !indexedHeight.Valid {
			writeHoldingsError(w, http.StatusServiceUnavailable, "holdings index not ready")
			return
		}
		rows, err := tx.QueryContext(r.Context(), `SELECT e.collection_id, e.token_number, e.to_owner, e.event_block
			FROM launchpad_nft_ownership_events AS e
			WHERE e.chain_id=? AND e.to_owner=? AND e.kind IN ('minted', 'transferred')
			  AND e.event_block<=?
			  AND (?='' OR e.collection_id>? OR (e.collection_id=? AND e.token_number>?))
			  AND NOT EXISTS (
			    SELECT 1 FROM launchpad_nft_ownership_events AS later
			    WHERE later.chain_id=e.chain_id AND later.collection_id=e.collection_id
			      AND later.token_number=e.token_number
			      AND later.event_block<=?
			      AND (later.event_block, later.event_tx_index, later.event_index) >
			          (e.event_block, e.event_tx_index, e.event_index)
			  )
			ORDER BY e.collection_id, e.token_number LIMIT ?`,
			expectedChainID, owner, indexedHeight.Int64,
			afterCollection, afterCollection, afterCollection, afterNumber, indexedHeight.Int64, limit+1)
		if err != nil {
			serveHoldingsError(w, err)
			return
		}
		items := make([]launchpadHolding, 0, limit+1)
		for rows.Next() {
			var item launchpadHolding
			if err := rows.Scan(&item.Collection, &item.Number, &item.Owner, &item.LastEventBlock); err != nil {
				_ = rows.Close()
				serveHoldingsError(w, err)
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			serveHoldingsError(w, err)
			return
		}
		if err := rows.Close(); err != nil {
			serveHoldingsError(w, err)
			return
		}
		response := launchpadHoldingsResponse{ChainID: expectedChainID, IndexedHeight: indexedHeight.Int64, Items: items}
		if len(items) > limit {
			response.Items = items[:limit]
			last := response.Items[len(response.Items)-1]
			response.NextCursor = encodeLaunchpadHoldingsCursor(last.Collection, last.Number)
		}
		if err := tx.Commit(); err != nil {
			serveHoldingsError(w, err)
			return
		}
		_ = json.NewEncoder(w).Encode(response)
	})
}

func serveHoldingsError(w http.ResponseWriter, err error) {
	slog.Warn("launchpad holdings query failed", "error", err)
	writeHoldingsError(w, http.StatusServiceUnavailable, "holdings unavailable")
}

func writeHoldingsError(w http.ResponseWriter, status int, message string) {
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func encodeLaunchpadHoldingsCursor(collection string, number int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(collection + ":" + strconv.FormatInt(number, 10)))
}

func decodeLaunchpadHoldingsCursor(raw string) (string, int64, error) {
	if raw == "" {
		return "", 0, nil
	}
	if len(raw) > 128 {
		return "", 0, fmt.Errorf("cursor too long")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return "", 0, err
	}
	collection, numberRaw, ok := strings.Cut(string(decoded), ":")
	if !ok || len(collection) < 2 || len(collection) > 32 || collection[0] != 'C' {
		return "", 0, fmt.Errorf("invalid collection cursor")
	}
	collectionNumber, err := strconv.ParseInt(collection[1:], 10, 64)
	if err != nil || collectionNumber <= 0 || "C"+strconv.FormatInt(collectionNumber, 10) != collection {
		return "", 0, fmt.Errorf("invalid collection cursor")
	}
	number, err := strconv.ParseInt(numberRaw, 10, 64)
	if err != nil || number <= 0 || strconv.FormatInt(number, 10) != numberRaw {
		return "", 0, fmt.Errorf("invalid token cursor")
	}
	return collection, number, nil
}

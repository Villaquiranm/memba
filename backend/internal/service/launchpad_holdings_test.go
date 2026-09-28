package service

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	dbpkg "github.com/samouraiworld/memba/backend/internal/db"
)

func launchpadHoldingsDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := dbpkg.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	if err := dbpkg.Migrate(database); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func addHoldingEvent(t *testing.T, database *sql.DB, chain string, block int, index int, collection string, number int, kind, from, to string) {
	t.Helper()
	_, err := database.Exec(`INSERT INTO launchpad_nft_ownership_events
		(chain_id, pkg_path, event_block, event_tx_index, event_index, collection_id,
		 token_number, kind, from_owner, to_owner, actor, reason)
		VALUES (?, 'gno.land/r/samcrew/launchpad/nft/v1', ?, 0, ?, ?, ?, ?, ?, ?, 'g1actor0000000000000000000000000000000', '')`,
		chain, block, index, collection, number, kind, from, to)
	if err != nil {
		t.Fatal(err)
	}
}

func holdingsRequest(t *testing.T, h http.Handler, values url.Values) (int, launchpadHoldingsResponse) {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/api/nft/launchpad-holdings?"+values.Encode(), nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var body launchpadHoldingsResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode holdings: %v", err)
		}
	}
	return w.Code, body
}

func TestLaunchpadHoldingsLatestOwnerAndPagination(t *testing.T) {
	database := launchpadHoldingsDB(t)
	ownerA, ownerB := "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "g1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	for _, chain := range []string{"gnoland-1", "pearl-1"} {
		if _, err := database.Exec(`INSERT INTO launchpad_nft_indexed_blocks (chain_id, height, hash) VALUES (?, 20, 'H20')`, chain); err != nil {
			t.Fatal(err)
		}
	}
	addHoldingEvent(t, database, "gnoland-1", 10, 0, "C1", 1, "minted", "", ownerA)
	addHoldingEvent(t, database, "gnoland-1", 10, 1, "C1", 2, "minted", "", ownerA)
	addHoldingEvent(t, database, "gnoland-1", 11, 0, "C1", 2, "transferred", ownerA, ownerB)
	addHoldingEvent(t, database, "gnoland-1", 10, 2, "C2", 1, "minted", "", ownerA)
	addHoldingEvent(t, database, "gnoland-1", 12, 0, "C2", 1, "burned", ownerA, "")
	addHoldingEvent(t, database, "gnoland-1", 13, 0, "C3", 1, "minted", "", ownerA)
	addHoldingEvent(t, database, "gnoland-1", 21, 0, "C3", 1, "transferred", ownerA, ownerB)
	addHoldingEvent(t, database, "gnoland-1", 21, 1, "C5", 1, "minted", "", ownerA)
	addHoldingEvent(t, database, "pearl-1", 14, 0, "C4", 1, "minted", "", ownerA)
	h := HandleLaunchpadHoldings(database, "gnoland-1", true, func() bool { return true })
	q := url.Values{"chain_id": {"gnoland-1"}, "owner": {ownerA}, "limit": {"1"}}
	status, page := holdingsRequest(t, h, q)
	if status != http.StatusOK || page.ChainID != "gnoland-1" || page.IndexedHeight != 20 ||
		len(page.Items) != 1 || page.Items[0].Collection != "C1" || page.Items[0].Number != 1 || page.NextCursor == "" {
		t.Fatalf("first page: status=%d body=%+v", status, page)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/nft/launchpad-holdings?"+q.Encode(), nil))
	if !strings.Contains(w.Body.String(), `"number":"1"`) {
		t.Fatalf("token number must remain a decimal string for JS precision: %s", w.Body.String())
	}
	q.Set("cursor", page.NextCursor)
	status, page = holdingsRequest(t, h, q)
	if status != http.StatusOK || len(page.Items) != 1 || page.Items[0].Collection != "C3" || page.NextCursor != "" {
		t.Fatalf("second page: status=%d body=%+v", status, page)
	}
	q.Set("owner", ownerB)
	q.Del("cursor")
	status, page = holdingsRequest(t, h, q)
	if status != http.StatusOK || len(page.Items) != 1 || page.Items[0].Collection != "C1" || page.Items[0].Number != 2 {
		t.Fatalf("transferred owner: status=%d body=%+v", status, page)
	}
}

func TestLaunchpadHoldingsFailsClosed(t *testing.T) {
	database := launchpadHoldingsDB(t)
	owner := "g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	q := url.Values{"chain_id": {"gnoland-1"}, "owner": {owner}}
	status, _ := holdingsRequest(t, HandleLaunchpadHoldings(database, "gnoland-1", false, func() bool { return true }), q)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("disabled endpoint status %d", status)
	}
	h := HandleLaunchpadHoldings(database, "gnoland-1", true, func() bool { return true })
	status, _ = holdingsRequest(t, h, q)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("unindexed endpoint status %d", status)
	}
	if _, err := database.Exec(`INSERT INTO launchpad_nft_indexed_blocks (chain_id, height, hash) VALUES ('gnoland-1', 10, 'H10')`); err != nil {
		t.Fatal(err)
	}
	status, _ = holdingsRequest(t, HandleLaunchpadHoldings(database, "gnoland-1", true, func() bool { return false }), q)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("stalled index endpoint status %d", status)
	}
	q.Set("chain_id", "pearl-1")
	status, _ = holdingsRequest(t, h, q)
	if status != http.StatusConflict {
		t.Fatalf("wrong chain status %d", status)
	}
	q.Set("chain_id", "gnoland-1")
	q.Set("cursor", "not-base64")
	status, _ = holdingsRequest(t, h, q)
	if status != http.StatusBadRequest {
		t.Fatalf("bad cursor status %d", status)
	}
	q.Del("cursor")
	q.Set("limit", "5000")
	status, _ = holdingsRequest(t, h, q)
	if status != http.StatusBadRequest {
		t.Fatalf("unbounded limit status %d", status)
	}
}

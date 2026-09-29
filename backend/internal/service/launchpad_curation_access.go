package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const launchpadCurationPath = "gno.land/r/samcrew/launchpad/curation/v1"

var launchpadCollectionID = regexp.MustCompile(`^C[1-9][0-9]{0,17}$`)

type launchpadReviewAccess struct {
	Collection string `json:"collection"`
	Account    string `json:"account"`
	Founder    string `json:"founder"`
	Revision   string `json:"revision"`
	Status     string `json:"status"`
	IsFounder  bool   `json:"isFounder"`
	IsManager  bool   `json:"isManager"`
	CanRead    bool   `json:"canRead"`
	CanReview  bool   `json:"canReview"`
}

type launchpadEditorialAccess struct {
	Collection string `json:"collection"`
	Account    string `json:"account"`
	Creator    string `json:"creator"`
	IsManager  bool   `json:"isManager"`
}

// HandleLaunchpadCurationAccess is a chain-bound, authenticated permission
// probe for the future private founder inbox. It does not grant inbox access
// by itself: every private read or write must call the same current-state
// verifier again. The URL is operator configuration, never request input.
func HandleLaunchpadCurationAccess(rpcURL, chainID string, enabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeHoldingsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !enabled || rpcURL == "" || chainID == "" {
			writeHoldingsError(w, http.StatusServiceUnavailable, "curation access unavailable")
			return
		}
		wallet, ok := AuthAddressFrom(r.Context())
		if !ok {
			writeHoldingsError(w, http.StatusUnauthorized, "wallet authentication required")
			return
		}
		collection := r.URL.Query().Get("collection")
		if !launchpadCollectionID.MatchString(collection) {
			writeHoldingsError(w, http.StatusBadRequest, "invalid collection")
			return
		}
		access, err := readLaunchpadReviewAccess(r.Context(), rpcURL, chainID, collection, wallet)
		if err != nil {
			slog.Warn("launchpad curation access read unavailable", "error", err)
			writeHoldingsError(w, http.StatusServiceUnavailable, "curation access unavailable")
			return
		}
		if access == nil {
			writeHoldingsError(w, http.StatusNotFound, "no application")
			return
		}
		_ = json.NewEncoder(w).Encode(access)
	})
}

// HandleLaunchpadEditorialAccess exposes a signed wallet's current manager
// eligibility for any existing NFT collection, including one without an
// application. The curation realm still enforces the action at transaction time.
func HandleLaunchpadEditorialAccess(rpcURL, chainID string, enabled bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			writeHoldingsError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		if !enabled || rpcURL == "" || chainID == "" {
			writeHoldingsError(w, http.StatusServiceUnavailable, "editorial access unavailable")
			return
		}
		wallet, ok := AuthAddressFrom(r.Context())
		if !ok {
			writeHoldingsError(w, http.StatusUnauthorized, "wallet authentication required")
			return
		}
		collection := r.URL.Query().Get("collection")
		if !launchpadCollectionID.MatchString(collection) {
			writeHoldingsError(w, http.StatusBadRequest, "invalid collection")
			return
		}
		access, err := readLaunchpadEditorialAccess(r.Context(), rpcURL, chainID, collection, wallet)
		if err != nil {
			slog.Warn("launchpad editorial access read unavailable", "error", err)
			writeHoldingsError(w, http.StatusServiceUnavailable, "editorial access unavailable")
			return
		}
		if access == nil {
			writeHoldingsError(w, http.StatusNotFound, "collection or account not found")
			return
		}
		_ = json.NewEncoder(w).Encode(access)
	})
}

func readLaunchpadReviewAccess(ctx context.Context, rpcURL, chainID, collection, wallet string) (*launchpadReviewAccess, error) {
	jsonText, err := readLaunchpadCurationAccessView(ctx, rpcURL, chainID, "ReviewAccessJSON", collection, wallet)
	if err != nil {
		return nil, err
	}
	if jsonText == "null" {
		return nil, nil
	}
	var access launchpadReviewAccess
	decoder := json.NewDecoder(strings.NewReader(jsonText))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&access); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("curation RPC trailing access data")
	}
	if access.Collection != collection || access.Account != wallet || !strings.HasPrefix(access.Founder, "g1") ||
		access.Revision == "" || access.Revision[0] == '0' || !decimalInt64(access.Revision) ||
		access.IsFounder != (access.Founder == wallet) || (access.IsFounder && access.IsManager) ||
		access.CanRead != (access.IsFounder || access.IsManager) ||
		access.CanReview != (access.IsManager && (access.Status == "submitted" || access.Status == "changes_requested")) ||
		!validCurationStatus(access.Status) {
		return nil, errors.New("curation RPC inconsistent access snapshot")
	}
	return &access, nil
}

func readLaunchpadEditorialAccess(ctx context.Context, rpcURL, chainID, collection, wallet string) (*launchpadEditorialAccess, error) {
	jsonText, err := readLaunchpadCurationAccessView(ctx, rpcURL, chainID, "EditorialAccessJSON", collection, wallet)
	if err != nil {
		return nil, err
	}
	if jsonText == "null" {
		return nil, nil
	}
	var access launchpadEditorialAccess
	decoder := json.NewDecoder(strings.NewReader(jsonText))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&access); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("curation RPC trailing editorial access data")
	}
	if access.Collection != collection || access.Account != wallet || !isValidGnoAddress(access.Creator) ||
		(access.Creator == wallet && access.IsManager) {
		return nil, errors.New("curation RPC inconsistent editorial access snapshot")
	}
	return &access, nil
}

func readLaunchpadCurationAccessView(ctx context.Context, rpcURL, chainID, method, collection, wallet string) (string, error) {
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	base := strings.TrimRight(rpcURL, "/")
	statusReq, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/status", nil)
	if err != nil {
		return "", err
	}
	statusBody, err := launchpadRPCBody(client, statusReq)
	if err != nil {
		return "", err
	}
	var status struct {
		Result struct {
			NodeInfo struct {
				Network string `json:"network"`
			} `json:"node_info"`
			SyncInfo struct {
				LatestBlockHeight string `json:"latest_block_height"`
				LatestBlockTime   string `json:"latest_block_time"`
				CatchingUp        bool   `json:"catching_up"`
			} `json:"sync_info"`
		} `json:"result"`
	}
	if err := json.Unmarshal(statusBody, &status); err != nil || status.Result.NodeInfo.Network != chainID {
		return "", fmt.Errorf("curation RPC chain mismatch or invalid status")
	}
	height, heightErr := strconv.ParseInt(status.Result.SyncInfo.LatestBlockHeight, 10, 64)
	blockTime, timeErr := time.Parse(time.RFC3339Nano, status.Result.SyncInfo.LatestBlockTime)
	blockAge := time.Since(blockTime)
	if heightErr != nil || height < 1 || timeErr != nil || status.Result.SyncInfo.CatchingUp ||
		blockAge < -30*time.Second || blockAge > 2*time.Minute {
		return "", fmt.Errorf("curation RPC is not at a recent chain head")
	}
	expr := launchpadCurationPath + "." + method + "(" + strconv.Quote(collection) + "," + strconv.Quote(wallet) + ")"
	request := abciQueryRequest{JSONRPC: "2.0", ID: 1, Method: "abci_query", Params: abciQueryParams{
		Path: "vm/qeval", Data: base64.StdEncoding.EncodeToString([]byte(expr)),
	}}
	payload, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	queryReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base, strings.NewReader(string(payload)))
	if err != nil {
		return "", err
	}
	queryReq.Header.Set("Content-Type", "application/json")
	queryBody, err := launchpadRPCBody(client, queryReq)
	if err != nil {
		return "", err
	}
	var response abciResponse
	if err := json.Unmarshal(queryBody, &response); err != nil || response.Error != nil ||
		abciErrorPresent(response.Result.Response.ResponseBase.Error) || response.Result.Response.ResponseBase.Data == "" {
		return "", fmt.Errorf("curation RPC query unavailable")
	}
	raw, err := base64.StdEncoding.DecodeString(response.Result.Response.ResponseBase.Data)
	if err != nil || len(raw) > 8192 {
		return "", fmt.Errorf("curation RPC invalid query data")
	}
	const suffix = " string)"
	if !strings.HasPrefix(string(raw), "(") || !strings.HasSuffix(string(raw), suffix) {
		return "", errors.New("curation RPC invalid typed response")
	}
	jsonText, err := strconv.Unquote(strings.TrimSuffix(string(raw[1:]), suffix))
	if err != nil {
		return "", err
	}
	return jsonText, nil
}

func launchpadRPCBody(client *http.Client, req *http.Request) ([]byte, error) {
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("RPC HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024+1))
	if err != nil || len(data) > 64*1024 {
		return nil, errors.New("RPC response unavailable or too large")
	}
	return data, nil
}

func decimalInt64(value string) bool {
	n, err := strconv.ParseInt(value, 10, 64)
	return err == nil && n > 0 && strconv.FormatInt(n, 10) == value
}

func validCurationStatus(status string) bool {
	return status == "submitted" || status == "changes_requested" || status == "recommended" || status == "declined"
}

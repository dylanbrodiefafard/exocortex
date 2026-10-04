package app

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

// HTTPSender sends requests with net/http.
type HTTPSender struct {
	Client *http.Client
}

func (s HTTPSender) Send(ctx context.Context, req Request) (int, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, req.URL, bytes.NewReader(req.Body))
	if err != nil {
		return 0, err
	}
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	client := s.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

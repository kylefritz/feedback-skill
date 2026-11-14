.PHONY: dev migrate-local comments test test-py test-worker deploy

PORT ?= 8791
COMMENTS = uv run scripts/comments.py --config example/wrangler.jsonc

migrate-local:   ## create/upgrade the local D1 that `make dev` uses
	cd example && wrangler d1 migrations apply feedback-comments --local

dev: migrate-local   ## the example on http://localhost:$(PORT) with a local D1
	cd example && wrangler dev --ip 127.0.0.1 --port $(PORT)

comments:        ## open notes in the local database (ALL=1 for every note)
	$(COMMENTS) --local $(if $(ALL),--all)

test: test-py test-worker   ## everything CI runs

test-py:         ## comments.py, the catalog/whitelist check
	uv run --with pytest pytest -q tests

test-worker:     ## worker.js validation against a fake D1
	node --test tests/worker.test.mjs

deploy:          ## yours: placeholders in example/wrangler.jsonc filled in first
	cd example && wrangler d1 migrations apply feedback-comments --remote
	cd example && wrangler deploy

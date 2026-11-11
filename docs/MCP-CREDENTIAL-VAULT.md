# MCP Credential Vault

The first vault slice stores MCP credentials encrypted at rest in the Hub SQLite database.

## Key provisioning

Set `MCP_CREDENTIAL_MASTER_KEY` to a base64-encoded, randomly generated 32-byte key before starting the Hub. Generate one with:

```sh
openssl rand -base64 32
```

Provision it through the deployment secret manager or process environment. Never commit it, put it in `mcp_servers.config_json`, or write it to logs. Back it up securely: losing the key makes stored credentials unrecoverable. Use a distinct key per environment and restrict process access.

## API boundary

- `storeMcpCredential(value)` encrypts with AES-256-GCM and returns a `mcpcred:<uuid>` reference.
- `readMcpCredential(reference)` authenticates and decrypts for trusted runtime adapters.
- `deleteMcpCredential(reference)` explicitly removes the encrypted record.

The database stores only key version, random 96-bit nonce, ciphertext, authentication tag, and timestamps. The reference UUID is authenticated as additional data. Invalid keys, unsupported versions, and authentication failures fail closed.

## Security limitations

This is an encrypted-at-rest primitive, not a complete secrets-management service. The master key is supplied by the deployment environment; no KMS integration, rotation workflow, OAuth refresh, access-control layer, audit trail, or memory-zeroization guarantee is implemented yet. Runtime adapters must authorize access to credential references and must never log decrypted values. Back up the master key separately from the database.

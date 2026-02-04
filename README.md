# LockTrip B2B Integration

Official integration documentation for LockTrip's hotel booking API.

## Overview

LockTrip provides B2B partners access to 2.5M+ hotel properties at wholesale rates through two integration methods:

| Integration | Best For | Documentation |
|-------------|----------|---------------|
| **GraphQL API** | Direct backend integration | [INTEGRATION.md](./INTEGRATION.md) |
| **MCP Server** | AI agents (Claude, etc.) | [MCP_INTEGRATION.md](./MCP_INTEGRATION.md) |

## Quick Start

### 1. Get Your B2B Account

Contact LockTrip to set up your B2B account with credit line:
- Account must have `isB2B: true` and `hasCL: true`
- You'll receive API access credentials

### 2. Get Your Bearer Token

```bash
curl -X POST https://users.locktrip.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "your-b2b-email@company.com", "password": "your-password"}'
```

### 3. Run the Test Script

```bash
# Install dependencies
npm install axios typescript tsx

# Test the search flow (safe - no charges)
BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts
```

## API Differences

| Aspect | GraphQL API | MCP API |
|--------|-------------|---------|
| Date format | `DD/MM/YYYY` | `YYYY-MM-DD` |
| Page numbers | 1-based | 0-indexed |
| hotelId type | NUMBER | String |
| Guest structure | `rooms[].adults[]` | `rooms[].guests[]` |

## Files

| File | Description |
|------|-------------|
| `INTEGRATION.md` | Complete GraphQL API documentation with sample responses |
| `MCP_INTEGRATION.md` | MCP Server documentation for AI agent integration |
| `e2e-graphql-test.ts` | Production-ready GraphQL test script |
| `e2e-mcp-test.ts` | Production-ready MCP test script |

## Booking Flow

```
1. Location Search    → Get regionId
2. Hotel Search       → Get searchKey
3. Poll Results       → Wait for completion (15-30s)
4. Get Rooms          → Get quoteId
5. Check Cancellation → Review refund terms
6. Prepare Booking    → Get bookingInternalId
7. Confirm Booking    → Charges credit line
```

## Support

For B2B onboarding and technical support, contact your LockTrip account manager.

---

*LockTrip - Decentralized Hotel Booking*

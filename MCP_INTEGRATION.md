# LockTrip MCP Server - AI Agent Integration Guide

> **Version**: 4.0.0
> **Last Updated**: 2026-02-06

---

## Introduction

LockTrip MCP Server exposes hotel booking capabilities to AI agents via the Model Context Protocol (MCP). This enables AI assistants like Claude to search hotels, compare prices, and complete bookings on behalf of users.

### What This API Offers

- **AI-native interface** - MCP protocol designed for LLM tool use
- **Access to 2.5M+ hotels** from major suppliers worldwide
- **B2B wholesale pricing** (10-30% below retail rates)
- **Complete booking lifecycle** - search, book, manage, cancel
- **REST endpoints** for non-MCP integrations (web apps, scripts)

### Who Should Use This

- **AI agent developers** building travel assistants
- **Claude Desktop users** wanting hotel booking capabilities
- **MCP client developers** integrating hotel inventory
- **Web app developers** needing simple REST-style hotel API

### MCP API vs GraphQL API

| Aspect | MCP API (this doc) | GraphQL API |
|--------|-------------------|-------------|
| Date format | `YYYY-MM-DD` (ISO) | `DD/MM/YYYY` |
| Page numbers | 0-indexed (0, 1, 2...) | 1-based (1, 2, 3...) |
| hotelId type | String (search) / Number (details) | Number |
| Guest structure | `rooms[].guests[]` + `rooms[].children[]` | `rooms[].adults[]` + `rooms[].children[]` |
| Guest titles | Optional (Mr, Mrs, Ms) | Required |
| Search by | regionId OR lat/lng coordinates | regionId OR lat/lng coordinates |
| Payment | B2B credit line OR Stripe | B2B credit line, Stripe, Revolut |
| Completion check | `searchStatus === 'COMPLETED'` | `isResultCompleted` |
| Use case | AI agents, MCP clients | Direct backend integration |

---

## Table of Contents

1. [Architecture & Endpoints](#1-architecture--endpoints)
2. [Authentication](#2-authentication)
3. [Complete Booking Flow](#3-complete-booking-flow)
4. [Tool Reference with Sample Responses](#4-tool-reference-with-sample-responses)
5. [Booking Management](#5-booking-management)
6. [Search Results & Filtering](#6-search-results--filtering)
7. [Error Handling](#7-error-handling)
8. [Test Script](#8-test-script)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Architecture & Endpoints

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   AI Agent      │────▶│   MCP Server    │────▶│  GraphQL API    │
│  (Claude, etc)  │ MCP │                 │HTTP │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Base URL

```
https://locktrip.com
```

### Available Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/mcp/health` | GET | No | Health check |
| `/mcp/tools` | GET | No | List all 12 available tools |
| `/mcp/sse` | GET | Optional | SSE stream for MCP clients |
| `/mcp/rpc` | POST | Optional | JSON-RPC 2.0 endpoint |
| `/mcp/tools/:name` | POST | Optional | Direct REST-style tool call |

### MCP Client Configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "locktrip": {
      "url": "https://locktrip.com/mcp/sse",
      "headers": {
        "Authorization": "Bearer eyJhbGciOiJIUzUxMiJ9..."
      }
    }
  }
}
```

### REST API Usage (Web Apps)

```bash
# Health check
curl https://locktrip.com/mcp/health

# List tools
curl https://locktrip.com/mcp/tools

# Call a tool (REST-style)
curl -X POST https://locktrip.com/mcp/tools/search_location \
  -H "Content-Type: application/json" \
  -d '{"query": "bali, indonesia"}'

# JSON-RPC style
curl -X POST https://locktrip.com/mcp/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_location",
      "arguments": {"query": "bali"}
    }
  }'
```

---

## 2. Authentication

### B2B Account Requirements

Your account must be B2B-enabled with an active credit line:

```json
{
  "isB2B": true,
  "hasCL": true
}
```

### Getting Your Bearer Token

**Option 1: Login API**
```bash
curl -X POST https://users.locktrip.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "your-b2b-email@company.com", "password": "your-password"}'
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzUxMiJ9...",
  "expiresIn": 86400
}
```

**Option 2: Browser DevTools**
1. Login at https://locktrip.com
2. DevTools → Application → Local Storage → copy `token`

### Auth Requirements

**All tool endpoints require Bearer token authentication.**

The token validates your B2B account and is used to:
- Track API usage per partner
- Apply B2B pricing to search results
- Enable booking and management operations

```bash
# All tool calls require Authorization header
curl -X POST https://locktrip.com/mcp/tools/search_location \
  -H "Authorization: Bearer eyJ..." \
  -H "Content-Type: application/json" \
  -d '{"query": "bali"}'
```

Only `/mcp/health` and `/mcp/tools` (GET) are public endpoints.

---

## 3. Complete Booking Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE BOOKING FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐                                                        │
│  │ 1. LOCATION     │  search_location("bali") → regionId                    │
│  │    SEARCH       │  Never hardcode regionId                               │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 2. HOTEL        │  hotel_search(regionId, dates) → searchKey             │
│  │    SEARCH       │  Date format: YYYY-MM-DD (ISO)                         │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 3. WAIT 2s      │  Mandatory delay before polling                        │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 4. POLL         │  get_search_results(searchKey) → hotels[]              │
│  │    RESULTS      │  Poll until searchStatus === 'COMPLETED'               │
│  └────────┬────────┘  Page: 0-indexed (start with 0)                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 5. GET ROOMS    │  get_hotel_rooms(hotelId) → quoteId                    │
│  │                 │  hotelId is STRING                                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 6. CANCELLATION │  check_cancellation_policy(packageIds)                 │
│  │    POLICY       │  packageId = quoteId.split('_')[0]                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 7. PREPARE      │  prepare_booking(guests) → bookingInternalId           │
│  │    BOOKING      │  Guest structure: rooms[].guests[]                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 8. CONFIRM      │  confirm_booking(bookingId) → accepted                 │
│  │    BOOKING      │  Charges credit line                                   │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     POST-BOOKING MANAGEMENT                          │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │  list_bookings(type) → list all bookings                            │    │
│  │  get_booking_details(id) → full booking info with voucher           │    │
│  │  cancel_booking(id, confirmed) → cancel and request refund          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Tool Reference with Sample Responses

### 4.1 search_location

Find the regionId for your destination. **Never hardcode regionId.**

**Input:**
```json
{ "query": "bali, indonesia" }
```

**Sample Response - REAL DATA:**
```json
{
  "locations": [
    {
      "id": "645f64dace586e4a12d943ed",
      "name": "Bali",
      "country": "Indonesia",
      "type": "REGION",
      "fullName": "Bali, Indonesia"
    },
    {
      "id": "6089739c76290b7c193c17b6",
      "name": "Kuta",
      "country": "Indonesia",
      "type": "CITY",
      "fullName": "Kuta, Badung Regency, Bali, Indonesia"
    },
    {
      "id": "5f0f445cdef47f4cef6cc46f",
      "name": "Ubud",
      "country": "Indonesia",
      "type": "CITY",
      "fullName": "Ubud, Gianyar Regency, Bali, Indonesia"
    },
    {
      "id": "645f64dace586e4a12d943ed_5879110",
      "name": "The Bali Bill Villa",
      "country": "Indonesia",
      "type": "HOTEL",
      "fullName": "The Bali Bill Villa, Bali, Indonesia"
    }
  ]
}
```

**Location Types:**
- `REGION` - State/Province (broad area search)
- `CITY` - City (city-specific search)
- `HOTEL` - Specific property

**Use:** First REGION or CITY `id` as your `regionId`

---

### 4.2 hotel_search

Initiate async hotel search. Returns immediately. Supports two modes: **region-based** (using regionId from search_location) or **coordinate-based** (using latitude/longitude).

**Input (Region-based):**
```json
{
  "regionId": "645f64dace586e4a12d943ed",
  "startDate": "2026-08-23",
  "endDate": "2026-08-25",
  "rooms": [{ "adults": 2, "childrenAges": [] }],
  "currency": "EUR",
  "nationality": "US"
}
```

**Input (Coordinate-based):**
```json
{
  "latitude": 48.2082,
  "longitude": 16.3738,
  "radiusInMeters": 5000,
  "startDate": "2026-08-23",
  "endDate": "2026-08-25",
  "rooms": [{ "adults": 2, "childrenAges": [] }],
  "currency": "EUR",
  "nationality": "US"
}
```

**Coordinate Search Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `latitude` | number | Yes (if no regionId) | -90 to 90 |
| `longitude` | number | Yes (if no regionId) | -180 to 180 |
| `radiusInMeters` | number | No | Search radius (default: 30000, min: 1000, max: 100000) |

**Note:** Either `regionId` OR `latitude`+`longitude` must be provided. Not both required.

**Sample Response:**
```json
{
  "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
  "sessionId": "sess_abc123def456",
  "status": "PENDING"
}
```

---

### 4.3 get_search_results

Poll for search results. **Wait 2+ seconds before first poll.**

**Input:**
```json
{
  "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
  "page": 0,
  "size": 5000,
  "sortBy": "PRICE_ASC",
  "filters": {}
}
```

**Sample Response (during polling - NORMAL):**
```json
{
  "hotels": [],
  "totalCount": 0,
  "page": 0,
  "pageSize": 5000,
  "hasMore": false,
  "searchStatus": "IN_PROGRESS"
}
```

**Sample Response (completed) - REAL DATA:**
```json
{
  "hotels": [
    {
      "hotelId": "17347136",
      "name": "Collection O Bali near Terminal Ubung",
      "starRating": 2,
      "address": "132 Hotel Batukaru, Denpasar",
      "latitude": -8.632039,
      "longitude": 115.203478,
      "images": ["https://imagecontent.net/images/full/90597062-bebe-4495-8c6e-17b54604ae3c.jpeg"],
      "amenities": [],
      "minPrice": 2.98,
      "originalPrice": 2.98,
      "currency": "EUR",
      "discountScore": 0,
      "distance": 24.79,
      "boardType": null,
      "payment": "Cash",
      "quality": 0.14,
      "reviewScore": 2.9,
      "reviewCount": null,
      "hasFreeCancellation": false,
      "isRefundable": false,
      "refundableUntil": null,
      "availableMealTypes": []
    },
    {
      "hotelId": "5948584",
      "name": "The Kayon Jungle Resort",
      "starRating": 5,
      "address": "Br. Bresela, Payangan, Gianyar",
      "latitude": -8.4231,
      "longitude": 115.2134,
      "images": ["https://imagecontent.net/images/full/hotel-5948584.jpeg"],
      "amenities": ["Pool", "Spa", "WiFi", "Restaurant", "Gym"],
      "minPrice": 127.50,
      "originalPrice": 195.00,
      "currency": "EUR",
      "discountScore": 35,
      "distance": 12.4,
      "boardType": "Breakfast",
      "payment": "Cash",
      "quality": 92,
      "reviewScore": 9.2,
      "reviewCount": 1247,
      "hasFreeCancellation": true,
      "isRefundable": true,
      "refundableUntil": "2026-08-20T00:00:00Z",
      "availableMealTypes": ["Room Only", "Breakfast", "Half Board"]
    }
  ],
  "totalCount": 2089,
  "page": 0,
  "pageSize": 5000,
  "hasMore": false,
  "searchStatus": "COMPLETED"
}
```

**Important Notes:**
- Fields can be null (boardType, reviewCount, refundableUntil)
- Empty arrays are common (amenities, availableMealTypes)
- discountScore 0 means no special deal
- images is an array with hotel's main photo
```

**Polling Logic:**
```javascript
await sleep(2000);  // MANDATORY

for (let attempt = 0; attempt < 30; attempt++) {
  const result = await mcpTool('get_search_results', {
    searchKey, page: 0, size: 5000, sortBy: 'PRICE_ASC', filters: {}
  });

  if (result.searchStatus === 'COMPLETED') {
    return result.hotels;
  }

  // Empty results at start is NORMAL
  await sleep(1000);
}
```

---

### 4.4 get_hotel_rooms

Get room packages for a specific hotel.

**Input:**
```json
{
  "hotelId": "5948584",
  "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
  "startDate": "2026-08-23",
  "endDate": "2026-08-25",
  "rooms": [{ "adults": 2, "childrenAges": [] }],
  "nationality": "US",
  "regionId": "645f64dace586e4a12d943ed",
  "currency": "EUR"
}
```

**Sample Response - REAL DATA:**
```json
{
  "hotelId": "17347136",
  "hotelName": "",
  "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
  "packages": [
    {
      "quoteId": "cde06235-53aa-489c-a383-62d79019e4e4_17347136",
      "packageId": "cde06235-53aa-489c-a383-62d79019e4e4_17347136",
      "roomName": "Double Deluxe",
      "roomDescription": "",
      "mealType": "Room Only",
      "mealDescription": "Room Only",
      "bedType": null,
      "maxOccupancy": 2,
      "amenities": [
        "Non-Smoking", "Air conditioning", "Private bathroom",
        "Free WiFi", "Flat-panel TV", "Free bottled water",
        "Daily housekeeping", "Bathrobes", "Free toiletries",
        "Satellite TV service", "Wardrobe or closet"
      ],
      "price": 2.98,
      "currency": "EUR",
      "pricePerNight": 2.98,
      "totalNights": 1,
      "isRefundable": true,
      "cancellationDeadline": null,
      "provider": null
    },
    {
      "quoteId": "5aaf061b-75ec-4da9-a8ef-8106b1012f27_17347136",
      "packageId": "5aaf061b-75ec-4da9-a8ef-8106b1012f27_17347136",
      "roomName": "Double Deluxe",
      "roomDescription": "",
      "mealType": "Breakfast Included",
      "mealDescription": "Breakfast Included",
      "bedType": null,
      "maxOccupancy": 2,
      "amenities": [
        "Non-Smoking", "Air conditioning", "Private bathroom",
        "Free WiFi", "Flat-panel TV", "Free bottled water"
      ],
      "price": 5.46,
      "currency": "EUR",
      "pricePerNight": 5.46,
      "totalNights": 1,
      "isRefundable": true,
      "cancellationDeadline": null,
      "provider": null
    }
  ],
  "checkIn": "2026-08-23",
  "checkOut": "2026-08-24"
}
```

**Key Fields:**
- `amenities` - detailed room amenities list (from roomContent)
- `packageId` - use `quoteId.split('_')[0]` for cancellation policy
- `hotelName` may be empty (use hotel name from search results)
- `cancellationDeadline` - use check_cancellation_policy for details
```

**Note:** The `searchKey` may be updated. Always use the returned value.

---

### 4.5 check_cancellation_policy

Get detailed cancellation terms.

**Input:**
```json
{
  "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
  "hotelId": "5948584",
  "packageIds": ["73513d6a-b452-449b-ae29-9797790ed569"]
}
```

**CRITICAL:** Extract `packageId` from `quoteId`:
```javascript
const packageId = quoteId.split('_')[0];
// "73513d6a-b452-449b-ae29-9797790ed569_5948584" → "73513d6a-b452-449b-ae29-9797790ed569"
```

**Sample Response:**
```json
{
  "hotelId": "5948584",
  "policies": [
    {
      "packageId": "73513d6a-b452-449b-ae29-9797790ed569",
      "isRefundable": true,
      "freeCancellationUntil": "2026-08-20T00:00:00Z",
      "fees": [
        {
          "fromDate": "2026-08-20T00:00:00Z",
          "toDate": "2026-08-22T00:00:00Z",
          "amount": 127.50,
          "currency": "EUR",
          "percentage": 50,
          "description": "50% cancellation fee"
        },
        {
          "fromDate": "2026-08-22T00:00:00Z",
          "toDate": null,
          "amount": 255.00,
          "currency": "EUR",
          "percentage": 100,
          "description": "No refund"
        }
      ],
      "remarks": ["Free cancellation until Aug 20, 2026"]
    }
  ]
}
```

---

### 4.6 prepare_booking

Create booking with guest details. **Does not charge.**

**Input:**
```json
{
  "quoteId": "73513d6a-b452-449b-ae29-9797790ed569_5948584",
  "rooms": [{
    "roomIndex": 0,
    "guests": [
      { "firstName": "John", "lastName": "Smith", "title": "Mr", "isLeadGuest": true },
      { "firstName": "Jane", "lastName": "Smith", "title": "Mrs" }
    ],
    "children": [
      { "firstName": "Billy", "lastName": "Smith", "age": 8 }
    ]
  }],
  "contactPerson": {
    "firstName": "John",
    "lastName": "Smith",
    "email": "john.smith@company.com",
    "phone": "+14155551234",
    "title": "Mr"
  }
}
```

**Guest Title:** Optional `title` field for adults and contact person. Values: `Mr`, `Mrs`, `Ms`. Defaults to `Mr`.

**Children:** Optional `children` array per room with `firstName`, `lastName`, and `age` (0-17). Children must match the `childrenAges` used in the original search.

**CRITICAL:** Adult guest count must match search exactly.

**Sample Response:**
```json
{
  "preparedBookingId": "698341601f3796feeed6a790",
  "bookingInternalId": "698341601f3796feeed6a790",
  "price": 255.00,
  "currency": "EUR",
  "payment": "Cash",
  "discount": null,
  "taxes": [
    {
      "feeTitle": "City Tax",
      "value": "2.50",
      "currency": "EUR",
      "isIncludedInPrice": false
    }
  ],
  "essentialInformation": [
    "Check-in: 14:00",
    "Check-out: 11:00",
    "Photo ID required at check-in"
  ]
}
```

---

### 4.7 confirm_booking

Confirm and pay via credit line. **This charges your account.**

**Input:**
```json
{
  "bookingInternalId": "698341601f3796feeed6a790",
  "quoteId": "73513d6a-b452-449b-ae29-9797790ed569_5948584",
  "paymentMethod": "CREDIT_LINE"
}
```

**Sample Response (Success):**
```json
{
  "accepted": true,
  "message": null,
  "voucherUrl": "https://locktrip.com/booking/hotel/voucher/698341601f3796feeed6a790"
}
```

**Note:** `voucherUrl` is only returned when `accepted` is `true`. Use this URL to view/share the booking voucher.

**Sample Response (Failure):**
```json
{
  "accepted": false,
  "message": "User is not b2b user"
}
```

---

## 5. Booking Management

### 5.1 list_bookings

**Input:**
```json
{
  "type": "UPCOMING"
}
```

**Types:** `UPCOMING`, `COMPLETED`, `CANCELLED`, `PENDING`, `ALL`

**Sample Response:**
```json
{
  "bookings": [
    {
      "bookingId": "698341601f3796feeed6a790",
      "bookingReferenceId": "LT-2026-ABC123",
      "hotelName": "The Kayon Jungle Resort",
      "hotelCity": "Ubud",
      "checkIn": "2026-08-23",
      "checkOut": "2026-08-25",
      "status": "CONFIRMED",
      "totalPrice": 255.00,
      "currency": "EUR",
      "guestName": "John Smith",
      "roomCount": 1,
      "createdAt": "2026-02-04T10:30:00Z"
    }
  ],
  "totalCount": 1,
  "page": 0,
  "pageSize": 20
}
```

---

### 5.2 get_booking_details

**Input:**
```json
{
  "bookingId": "698341601f3796feeed6a790"
}
```

**Sample Response:**
```json
{
  "bookingId": "698341601f3796feeed6a790",
  "bookingReferenceId": "LT-2026-ABC123",
  "providerReference": "HB-98765432",
  "status": "CONFIRMED",
  "hotel": {
    "id": "5948584",
    "name": "The Kayon Jungle Resort",
    "address": "Br. Bresela, Payangan, Gianyar",
    "city": "Ubud",
    "country": "Indonesia",
    "phone": "+62 361 978 888",
    "email": "reservations@kayonresort.com",
    "starRating": 5
  },
  "checkIn": "2026-08-23",
  "checkOut": "2026-08-25",
  "rooms": [
    {
      "roomName": "Deluxe Room with Garden View",
      "mealType": "Breakfast",
      "guests": [
        { "firstName": "John", "lastName": "Smith" },
        { "firstName": "Jane", "lastName": "Smith" }
      ],
      "price": 255.00
    }
  ],
  "contactPerson": {
    "firstName": "John",
    "lastName": "Smith",
    "email": "john.smith@company.com",
    "phone": "+14155551234"
  },
  "totalPrice": 255.00,
  "currency": "EUR",
  "paymentStatus": "PAID",
  "cancellationPolicy": {
    "isRefundable": true,
    "freeCancellationUntil": "2026-08-20T00:00:00Z",
    "fees": [
      { "fromDate": "2026-08-20", "amount": 127.50, "currency": "EUR" },
      { "fromDate": "2026-08-22", "amount": 255.00, "currency": "EUR" }
    ]
  },
  "specialRequests": null,
  "createdAt": "2026-02-04T10:30:00Z",
  "confirmedAt": "2026-02-04T10:30:05Z"
}
```

---

### 5.3 cancel_booking

**Input:**
```json
{
  "bookingId": "698341601f3796feeed6a790",
  "confirmed": true,
  "reason": "Change of plans"
}
```

**Sample Response:**
```json
{
  "success": true,
  "refundAmount": 255.00,
  "refundCurrency": "EUR",
  "cancellationFee": 0,
  "message": "Booking cancelled successfully. Full refund will be credited.",
  "cancellationReference": "CXL-2026-XYZ789"
}
```

---

### 5.4 get_hotel_details

Get detailed hotel information including description, amenities, reviews, and photos.

**Input:**
```json
{
  "hotelId": 17006858,
  "language": "en",
  "includeImages": true,
  "imageLimit": 20
}
```

**Note:** `hotelId` is a **number** (from search results `externalId`), not a string.

**Sample Response:**
```json
{
  "hotel": {
    "id": 17006858,
    "name": "Rosewood Vienna",
    "country": "Austria",
    "city": "Vienna",
    "star": 5,
    "address": "Petersplatz 7, Innere Stadt, 1010 Vienna, Austria",
    "latitude": 48.2088,
    "longitude": 16.3706,
    "description": "Housed in a historically significant building...",
    "phone": "+43 1 9012345",
    "countryCode": "AT",
    "hotelPhotos": [
      { "url": "https://imagecontent.net/images/full/hotel-17006858.jpeg" }
    ],
    "reviews": {
      "scoreSummary": "Exceptional",
      "commentSummary": "Guests love the central location...",
      "reviewsCount": 523,
      "keyWords": [
        { "name": "Location", "reviewsCount": 412, "score": 9.6, "comments": ["Perfect location"] }
      ]
    },
    "hotelAmenities": [
      {
        "hotelId": 17006858,
        "categoryName": "General",
        "features": [{ "_id": "wifi", "name": "Free WiFi" }]
      }
    ]
  },
  "additionalImages": [
    { "url": "https://imagecontent.net/images/full/extra1.jpeg" }
  ]
}
```

---

### 5.5 get_payment_url

Get a Stripe checkout URL for paying a prepared booking via credit card (alternative to B2B credit line).

**Input:**
```json
{
  "bookingId": "698341601f3796feeed6a790",
  "currency": "EUR",
  "backUrl": "https://yourapp.com/booking/cancelled",
  "successUrl": "https://yourapp.com/booking/success"
}
```

**Sample Response:**
```json
{
  "url": "https://checkout.stripe.com/c/pay/cs_live_...",
  "sessionId": "cs_live_a1b2c3d4..."
}
```

**Note:** Redirect the customer to `url` to complete payment. The `backUrl` is where they go if they cancel. `successUrl` is optional (defaults to LockTrip confirmation page).

---

## 6. Search Results & Filtering

### Recommended Approach

Fetch all results and filter locally:

```javascript
const results = await mcpTool('get_search_results', {
  searchKey,
  page: 0,
  size: 5000,      // Get all
  sortBy: 'PRICE_ASC',
  filters: {}
});

// Filter locally
const filtered = results.hotels.filter(hotel =>
  hotel.minPrice >= 50 &&
  hotel.minPrice <= 200 &&
  hotel.starRating >= 4 &&
  hotel.hasFreeCancellation
);
```

### Available Hotel Fields

| Field | Type | Description |
|-------|------|-------------|
| `hotelId` | string | Unique identifier |
| `name` | string | Hotel name |
| `starRating` | number | 1-5 stars |
| `address` | string | Street address |
| `latitude`, `longitude` | number | Coordinates |
| `images` | string[] | Photo URLs |
| `amenities` | string[] | Features list |
| `minPrice` | number | Lowest available price |
| `originalPrice` | number | Reference price for discount |
| `currency` | string | Price currency |
| `discountScore` | number | Deal quality (higher = better) |
| `distance` | number | From search center (km) |
| `boardType` | string | Default meal type |
| `payment` | string | "Cash" or "Card" |
| `quality` | number | Quality score |
| `reviewScore` | number | Rating 0-10 |
| `reviewCount` | number | Number of reviews |
| `hasFreeCancellation` | boolean | Free cancellation available |
| `isRefundable` | boolean | Currently refundable |
| `refundableUntil` | string | Free cancel deadline (ISO) |
| `availableMealTypes` | string[] | All meal options |

### Sort Options

| sortBy Value | Description |
|--------------|-------------|
| `PRICE_ASC` | Price low to high |
| `PRICE_DESC` | Price high to low |
| `RATING_DESC` | Rating high to low |
| `DISTANCE` | Distance from center |

---

## 7. Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `0 results after 30 polls` | Polling too fast | Wait 2+ seconds before first poll |
| `0 results forever` | Invalid regionId | Call search_location first |
| `Guest count mismatch` | Wrong guest count | Match exactly: 2 adults searched = 2 guests |
| `User is not b2b user` | Not B2B account | Contact LockTrip for B2B upgrade |
| `400 on cancellation` | Using full quoteId | Use `quoteId.split('_')[0]` |
| `Session expired` | Took too long | Restart from hotel_search |
| `Invalid date format` | Wrong format | Use YYYY-MM-DD (ISO) |

---

## 8. Test Script

Complete E2E test script: `e2e-mcp-test.ts`

```bash
# Install
npm install axios typescript tsx

# Search only (safe):
BEARER_TOKEN="eyJ..." npx tsx e2e-mcp-test.ts

# Full flow with booking (charges credit line, then cancels):
BEARER_TOKEN="eyJ..." npx tsx e2e-mcp-test.ts --book
```

---

## 9. Troubleshooting

### "0 results after many polls"

1. Did you call `search_location` first?
2. Is regionId from a fresh search (not hardcoded)?
3. Did you wait 2+ seconds before first poll?
4. Are dates in YYYY-MM-DD format?
5. Are dates 6+ months in future?
6. Is page set to 0 (0-indexed)?

### "400 error on cancellation policy"

Use packageId, not quoteId:
```javascript
// WRONG
packageIds: ["73513d6a-b452-449b-ae29-9797790ed569_5948584"]

// RIGHT
packageIds: ["73513d6a-b452-449b-ae29-9797790ed569"]
```

### "Guest count mismatch"

Guest count must exactly match search:
- Searched: `rooms: [{ adults: 2 }]`
- Booking: 2 guests in `rooms[0].guests[]`

---

## Quick Reference

```
┌──────────────────────────────────────────────────────────────────────┐
│                       MCP API QUICK REFERENCE                         │
├──────────────────────────────────────────────────────────────────────┤
│ Date format:        YYYY-MM-DD (ISO)                                  │
│ Page numbers:       0-indexed (0, 1, 2...)                            │
│ Completion check:   searchStatus === 'COMPLETED'                      │
│ hotelId type:       STRING (search) / NUMBER (get_hotel_details)      │
│ packageId:          quoteId.split('_')[0]                             │
│ Guest structure:    rooms[].guests[] with firstName, lastName, title  │
│ Children:           rooms[].children[] with firstName, lastName, age  │
│ Guest titles:       Mr, Mrs, Ms (optional, defaults to Mr)           │
│ Guest count:        Must match search exactly                         │
│ First poll wait:    2+ seconds mandatory                              │
│ Total search time:  15-30 seconds typical                             │
│ Session lifetime:   ~30 minutes                                       │
├──────────────────────────────────────────────────────────────────────┤
│ SEARCH: search_location OR coordinates (lat/lng)                      │
│                                                                        │
│ BOOK:  hotel_search → WAIT 2s → get_search_results                    │
│        → get_hotel_details (optional) → get_hotel_rooms               │
│        → check_cancellation_policy → prepare_booking                  │
│        → confirm_booking (credit line) OR get_payment_url (Stripe)    │
│                                                                        │
│ MANAGE: list_bookings → get_booking_details → cancel_booking          │
│                                                                        │
│ TOOLS (12): search_location, hotel_search, get_search_results,        │
│             get_hotel_rooms, check_cancellation_policy,                │
│             prepare_booking, confirm_booking, list_bookings,           │
│             get_booking_details, cancel_booking,                       │
│             get_hotel_details, get_payment_url                         │
└──────────────────────────────────────────────────────────────────────┘
```

---

*Document version 4.0 - Updated with coordinate search, hotel details, guest titles/children, Stripe payment, and voucher URLs*

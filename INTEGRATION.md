# LockTrip GraphQL API - B2B Integration Guide

> **Version**: 2.2.0
> **Last Updated**: 2026-02-06

---

## Introduction

LockTrip is a blockchain-powered hotel booking platform aggregating 2.5M+ properties from major suppliers (Booking.com, Expedia, Hotelbeds, etc.) at wholesale B2B rates. This guide covers direct GraphQL API integration for B2B partners with credit line accounts.

### What This API Offers

- **Real-time hotel search** across 2.5M+ properties worldwide
- **Wholesale B2B pricing** (typically 10-30% below retail)
- **Credit line payments** - no per-transaction payment processing
- **Instant booking confirmation** with supplier voucher
- **Full booking lifecycle** - search, book, manage, cancel

### Who Should Use This

- B2B travel agencies building custom booking interfaces
- Travel management companies integrating hotel inventory
- Developers building travel applications with backend access

### GraphQL API vs MCP API

| Aspect | GraphQL API (this doc) | MCP API |
|--------|------------------------|---------|
| Date format | `DD/MM/YYYY` | `YYYY-MM-DD` (ISO) |
| Page numbers | 1-based (1, 2, 3...) | 0-indexed (0, 1, 2...) |
| hotelId type | NUMBER for getHotelRooms | String |
| Guest structure | `rooms[].adults[]` | `rooms[].guests[]` |
| Completion check | `isResultCompleted` | `searchStatus === 'COMPLETED'` |
| Use case | Direct backend integration | AI agent integration |

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [API Endpoint](#2-api-endpoint)
3. [Complete Booking Flow](#3-complete-booking-flow)
4. [API Reference with Sample Responses](#4-api-reference-with-sample-responses)
5. [Booking Management](#5-booking-management)
6. [Error Handling](#6-error-handling)
7. [Test Script](#7-test-script)

---

## 1. Authentication

### B2B Account Requirements

Your account MUST have B2B status with an active credit line:

```json
{
  "isB2B": true,
  "hasCL": true
}
```

Without B2B status, `confirmB2bBooking` returns: `"User is not b2b user"`

### Getting Your Bearer Token

**Option 1: Login via API**
```bash
curl -X POST https://users.locktrip.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "your-b2b-email@company.com", "password": "your-password"}'
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaWF0IjoxNTE2MjM5MDIyfQ...",
  "expiresIn": 86400
}
```

**Option 2: Browser DevTools**
1. Login at https://locktrip.com
2. Open DevTools → Application → Local Storage
3. Copy the `token` value

### Using the Token

All requests require the Bearer token in the Authorization header:

```bash
curl -X POST https://locktrip.com/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzUxMiJ9..." \
  -d '{"query": "...", "variables": {...}}'
```

---

## 2. API Endpoint

| Environment | Endpoint |
|-------------|----------|
| Production | `https://locktrip.com/graphql` |
| Local Dev | `http://localhost:3000/graphql` |

---

## 3. Complete Booking Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE BOOKING FLOW                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐                                                        │
│  │ 1. LOCATION     │  locationSearch("bali") → regionId                     │
│  │    SEARCH       │  Never hardcode regionId                               │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 2. HOTEL        │  hotelSearch(regionId, dates) → searchKey              │
│  │    SEARCH       │  Date format: DD/MM/YYYY                               │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 3. WAIT 2s      │  Mandatory delay before polling                        │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 4. POLL         │  hotelSearchResults(searchKey) → hotels[]              │
│  │    RESULTS      │  Poll until isResultCompleted === true                 │
│  └────────┬────────┘  Page: 1-based (start with 1)                          │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 5. GET ROOMS    │  getHotelRooms(hotelId) → quoteId                      │
│  │                 │  hotelId must be NUMBER (parseInt)                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 6. CANCELLATION │  hotelCancellationPolicies(packageIds)                 │
│  │    POLICY       │  packageId = quoteId.split('_')[0]                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 7. PREPARE      │  hotelBookingPrepare(guests) → preparedBookingId       │
│  │    BOOKING      │  Guest structure: rooms[].adults[]                     │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────┐                                                        │
│  │ 8. CONFIRM      │  confirmB2bBooking(bookingId) → accepted               │
│  │    BOOKING      │  Charges credit line                                   │
│  └────────┬────────┘                                                        │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                     POST-BOOKING MANAGEMENT                          │    │
│  ├─────────────────────────────────────────────────────────────────────┤    │
│  │  getUserBookings(type) → list bookings                              │    │
│  │  getBookingDetails(id) → full booking info                          │    │
│  │  cancelBookingRequest(id, confirmed) → cancel booking               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. API Reference with Sample Responses

### 4.1 Location Search

Find the regionId for your destination. **Never hardcode regionId.**

**Query:**
```graphql
query LocationSearch($query: String!) {
  locationSearch(query: $query) {
    locationData
  }
}
```

**Variables:**
```json
{ "query": "bali, indonesia" }
```

**Sample Response - REAL DATA:**
```json
{
  "data": {
    "locationSearch": {
      "locationData": [
        {
          "id": "645f64dace586e4a12d943ed",
          "externalId": "ChIJoQ8Q6NNB0S0RkOYkS7EPkSQ",
          "hotelCount": 0,
          "type": "administrative_area_level_1",
          "query": "Bali, Indonesia"
        },
        {
          "id": "6089739c76290b7c193c17b6",
          "externalId": "ChIJN3P2zJlG0i0RACx9yvsLAwQ",
          "hotelCount": 0,
          "type": "locality",
          "query": "Kuta, Badung Regency, Bali, Indonesia"
        },
        {
          "id": "5f0f445cdef47f4cef6cc46f",
          "externalId": "ChIJw8kin3M90i0RHD13a_2Ko1Q",
          "hotelCount": 0,
          "type": "locality",
          "query": "Ubud, Gianyar Regency, Bali, Indonesia"
        },
        {
          "id": "645f64dace586e4a12d943ed_5879110",
          "displayName": "The Bali Bill Villa",
          "query": "The Bali Bill Villa, Bali, Indonesia",
          "type": "Apartment",
          "score": 28.49
        }
      ]
    }
  }
}
```

**Location Types:**
- `administrative_area_level_1` - Region/State (use for broad searches)
- `locality` - City (use for city-specific searches)
- `Apartment`, `Hotel` - Specific properties (includes `displayName` and `score`)

**Use:** First region/locality `id` as your `regionId` (e.g., `645f64dace586e4a12d943ed`)

---

### 4.2 Hotel Search

Initiate an async search. Returns immediately with a searchKey.

**Mutation:**
```graphql
mutation HotelSearch($searchHotelsInput: searchHotelsInput!, $isAsyncSearch: Boolean) {
  hotelSearch(searchHotelsInput: $searchHotelsInput, isAsyncSearch: $isAsyncSearch) {
    searchKey
    sessionId
  }
}
```

**Variables (Region-based):**
```json
{
  "searchHotelsInput": {
    "regionId": "645f64dace586e4a12d943ed",
    "startDate": "23/08/2026",
    "endDate": "25/08/2026",
    "currency": "EUR",
    "rooms": [{ "adults": 2, "children": [] }],
    "uuid": "unique-search-id-123",
    "nat": "US"
  },
  "isAsyncSearch": true
}
```

**Variables (Coordinate-based):**
```json
{
  "searchHotelsInput": {
    "latitude": 48.2082,
    "longitude": 16.3738,
    "radiusInMeters": 5000,
    "startDate": "23/08/2026",
    "endDate": "25/08/2026",
    "currency": "EUR",
    "rooms": [{ "adults": 2, "children": [] }],
    "uuid": "unique-search-id-123",
    "nat": "US"
  },
  "isAsyncSearch": true
}
```

**Coordinate Search Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `regionId` | String | No (if lat/lng provided) | Location ID from search |
| `latitude` | Float | No (if regionId provided) | Latitude (-90 to 90) |
| `longitude` | Float | No (if regionId provided) | Longitude (-180 to 180) |
| `radiusInMeters` | Int | No | Search radius (default: 30000, min: 1000, max: 100000) |

**Note:** Either `regionId` OR `latitude`+`longitude` must be provided.

**Sample Response:**
```json
{
  "data": {
    "hotelSearch": {
      "searchKey": "fa0060c7a52e5a8f81ab63f0a7808f39",
      "sessionId": "sess_abc123def456"
    }
  }
}
```

---

### 4.3 Poll Search Results

**CRITICAL:** Wait 2+ seconds before first poll. Empty results for first 5-10 polls is normal.

**Query:**
```graphql
query HotelSearchResults($input: SearchResultsInput!) {
  hotelSearchResults(input: $input) {
    results {
      externalId
      name
      star
      address
      latitude
      longitude
      price
      discountScore
      distance
      boardType
      payment
      quality
      reviewsScore
      hasFreeCancellationOption
      refundability
      refundableUntil
      availableBoards
      reviews {
        scoreSummary
        reviewsCount
      }
      hotelPhoto {
        url
      }
      features
    }
    totalResults
    page
    size
    hasNextPage
    isResultCompleted
    isSearchFinished
  }
}
```

**Variables:**
```json
{
  "input": {
    "searchKey": "fa0060c7a52e5a8f81ab63f0a7808f39",
    "page": 1,
    "size": 100,
    "filters": {},
    "sortParams": ["price", "asc"],
    "singleHotelId": 0
  }
}
```

**Sample Response (during polling):**
```json
{
  "data": {
    "hotelSearchResults": {
      "results": [],
      "totalResults": 0,
      "page": 1,
      "size": 100,
      "hasNextPage": false,
      "isResultCompleted": false,
      "isSearchFinished": false
    }
  }
}
```

**Sample Response (completed) - REAL DATA:**
```json
{
  "data": {
    "hotelSearchResults": {
      "results": [
        {
          "externalId": 17347136,
          "name": "Collection O Bali near Terminal Ubung",
          "star": 2,
          "address": "132 Hotel Batukaru, Denpasar",
          "latitude": -8.632039,
          "longitude": 115.203478,
          "price": 2.98,
          "lastBestPrice": 2.98,
          "discountScore": 0,
          "distance": 24.79,
          "boardType": null,
          "payment": "Cash",
          "quality": 0.14,
          "reviewsScore": 2.9,
          "hasFreeCancellationOption": false,
          "refundability": false,
          "refundableUntil": null,
          "availableBoards": [],
          "reviews": {
            "scoreSummary": null,
            "reviewsCount": null
          },
          "hotelPhoto": {
            "url": "https://imagecontent.net/images/full/90597062-bebe-4495-8c6e-17b54604ae3c.jpeg"
          },
          "features": []
        },
        {
          "externalId": 5948584,
          "name": "The Kayon Jungle Resort",
          "star": 5,
          "address": "Br. Bresela, Payangan, Gianyar",
          "latitude": -8.4231,
          "longitude": 115.2134,
          "price": 127.50,
          "lastBestPrice": 195.00,
          "discountScore": 35,
          "distance": 12.4,
          "boardType": "Breakfast",
          "payment": "Cash",
          "quality": 92,
          "reviewsScore": 9.2,
          "hasFreeCancellationOption": true,
          "refundability": true,
          "refundableUntil": "2026-08-20T00:00:00Z",
          "availableBoards": ["Room Only", "Breakfast", "Half Board"],
          "reviews": {
            "scoreSummary": 9.2,
            "reviewsCount": 1247
          },
          "hotelPhoto": {
            "url": "https://imagecontent.net/images/full/hotel-5948584.jpeg"
          },
          "features": ["Pool", "Spa", "WiFi", "Restaurant", "Gym"]
        }
      ],
      "totalResults": 2089,
      "page": 1,
      "size": 100,
      "hasNextPage": true,
      "isResultCompleted": true,
      "isSearchFinished": true
    }
  }
}
```

**Important Field Notes:**
- `externalId` is a NUMBER (use as string for subsequent calls)
- `refundability` is BOOLEAN (not string)
- `boardType` can be null
- `availableBoards` can be empty array
- `reviews.scoreSummary` can be null
- `hotelPhoto.url` is the main hotel image
```

**Polling Logic:**
```javascript
await sleep(2000);  // MANDATORY 2s wait

for (let attempt = 0; attempt < 30; attempt++) {
  const result = await graphql(QUERY, { input: { searchKey, page: 1, size: 100 } });

  if (result.hotelSearchResults.isResultCompleted) {
    return result.hotelSearchResults.results;
  }

  await sleep(1000);
}
```

---

### 4.4 Get Hotel Rooms

Get available room packages for a specific hotel.

**Query:**
```graphql
query GetHotelRooms($input: GetRoomsInput) {
  getHotelRooms(input: $input) {
    searchKey
    hotelRoomsResponse {
      quoteId
      refundable
      finalPrice
      mealType
      roomType
      originalName
      payment
      roomCount
      roomContent {
        amenities
        images
        descriptions
      }
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "searchKey": "fa0060c7a52e5a8f81ab63f0a7808f39",
    "hotelId": 5948584,
    "startDate": "23/08/2026",
    "endDate": "25/08/2026",
    "regionId": "645f64dace586e4a12d943ed",
    "rooms": [{ "adults": 2, "children": [] }],
    "currency": "EUR",
    "nat": "US"
  }
}
```

**IMPORTANT:** `hotelId` must be a NUMBER (use `parseInt(externalId, 10)`)

**Sample Response - REAL DATA:**
```json
{
  "data": {
    "getHotelRooms": {
      "searchKey": "fdd291c01f8a77809f176ccc279e2a0a",
      "hotelRoomsResponse": [
        {
          "quoteId": "cde06235-53aa-489c-a383-62d79019e4e4_17347136",
          "refundable": true,
          "finalPrice": 2.98,
          "mealType": "Room Only",
          "roomType": "Deluxe Room, Double Or Twin Beds",
          "originalName": "Double Deluxe",
          "payment": "Cash",
          "roomCount": 1,
          "roomContent": {
            "amenities": [
              "Non-Smoking", "Air conditioning", "Private bathroom",
              "Free WiFi", "Flat-panel TV", "Free bottled water",
              "Daily housekeeping", "Bathrobes", "Free toiletries"
            ],
            "images": [
              "https://imagecontent.net/images/fullrm/a15e00fa-32ab-4d46-bd8f-04a08c2fc05e.jpeg",
              "https://imagecontent.net/images/fullrm/40629a60-0e00-4c4d-8b5a-aaa5ca3f6656.jpeg",
              "https://imagecontent.net/images/fullrm/314ee165-e5b7-41a0-824d-e9535ef84c9d.jpeg"
            ],
            "descriptions": []
          }
        },
        {
          "quoteId": "5aaf061b-75ec-4da9-a8ef-8106b1012f27_17347136",
          "refundable": true,
          "finalPrice": 5.46,
          "mealType": "Breakfast Included",
          "roomType": "Deluxe Room, Double Or Twin Beds",
          "originalName": "Double Deluxe",
          "payment": "Cash",
          "roomCount": 1,
          "roomContent": {
            "amenities": [
              "Non-Smoking", "Air conditioning", "Private bathroom",
              "Free WiFi", "Flat-panel TV", "Free bottled water"
            ],
            "images": [
              "https://imagecontent.net/images/fullrm/a15e00fa-32ab-4d46-bd8f-04a08c2fc05e.jpeg"
            ],
            "descriptions": []
          }
        }
      ]
    }
  }
}
```

**Key Fields:**
- `roomContent.amenities` - detailed list of room features
- `roomContent.images` - room-specific photos (different from hotel photos)
- `quoteId` format: `{packageId}_{hotelId}` - extract packageId for cancellation policy

**Note:** The `searchKey` may be updated. Always use the returned value for subsequent calls.

---

### 4.5 Check Cancellation Policy

Get detailed cancellation terms before booking.

**Query:**
```graphql
query HotelCancellationPolicies(
  $searchKey: String!
  $hotelId: String!
  $packageIds: [String!]!
) {
  hotelCancellationPolicies(
    searchKey: $searchKey
    hotelId: $hotelId
    packageIds: $packageIds
  ) {
    packageId
    fallbackPolicy
    cancellations {
      nonRefundable
      boardType
      roomType
      originalName
      canxFees {
        amount { amt }
        from
      }
    }
  }
}
```

**Variables:**
```json
{
  "searchKey": "fa0060c7a52e5a8f81ab63f0a7808f39",
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
  "data": {
    "hotelCancellationPolicies": [
      {
        "packageId": "73513d6a-b452-449b-ae29-9797790ed569",
        "fallbackPolicy": null,
        "cancellations": [
          {
            "nonRefundable": false,
            "boardType": "Breakfast",
            "roomType": "Deluxe Room",
            "originalName": "Deluxe Room with Garden View - Breakfast Included",
            "canxFees": [
              {
                "amount": { "amt": 0 },
                "from": 1724284800000
              },
              {
                "amount": { "amt": 127.50 },
                "from": 1724457600000
              },
              {
                "amount": { "amt": 255.00 },
                "from": 1724544000000
              }
            ]
          }
        ]
      }
    ]
  }
}
```

**Interpreting canxFees:**
- `from` is Unix timestamp in milliseconds
- First entry (amt: 0): Free cancellation until this date
- Subsequent entries: Penalty amount after that date
- Last entry typically equals full booking cost (no refund)

---

### 4.6 Prepare Booking

Create a booking with guest details. Does NOT charge - just prepares.

**Mutation:**
```graphql
mutation HotelBookingPrepare($bookingCreateInput: BookingCreateInput!) {
  hotelBookingPrepare(bookingCreateInput: $bookingCreateInput) {
    preparedBookingId
    fiatPrice
    currency
    isUpfrontPaid
    essentialInformation
    payment
    discount {
      amount
      currency
    }
    taxes {
      feeTitle
      value
      currency
      isIncludedInPrice
    }
  }
}
```

**Variables:**
```json
{
  "bookingCreateInput": {
    "quoteId": "73513d6a-b452-449b-ae29-9797790ed569_5948584",
    "rooms": [{
      "adults": [
        { "title": "Mr", "firstName": "John", "lastName": "Smith" },
        { "title": "Mrs", "firstName": "Jane", "lastName": "Smith" }
      ],
      "children": []
    }],
    "contactPerson": {
      "title": "Mr",
      "firstName": "John",
      "lastName": "Smith",
      "email": "john.smith@company.com",
      "phone": "+14155551234"
    }
  }
}
```

**CRITICAL:** Guest count must match search. Searched 2 adults = exactly 2 adults in booking.

**Sample Response:**
```json
{
  "data": {
    "hotelBookingPrepare": {
      "preparedBookingId": "698341601f3796feeed6a790",
      "fiatPrice": 255.00,
      "currency": "EUR",
      "isUpfrontPaid": false,
      "essentialInformation": [
        "Check-in: 14:00",
        "Check-out: 11:00",
        "Photo ID required at check-in"
      ],
      "payment": "Cash",
      "discount": null,
      "taxes": [
        {
          "feeTitle": "City Tax",
          "value": "2.50",
          "currency": "EUR",
          "isIncludedInPrice": false
        }
      ]
    }
  }
}
```

---

### 4.7 Confirm B2B Booking

Confirm and pay via credit line. **This charges your account.**

**Mutation:**
```graphql
mutation ConfirmB2bBooking($bookingConfirmInput: BookingConfirmInput!) {
  confirmB2bBooking(bookingConfirmInput: $bookingConfirmInput) {
    accepted
    message
  }
}
```

**Variables:**
```json
{
  "bookingConfirmInput": {
    "bookingInternalId": "698341601f3796feeed6a790",
    "quoteId": "73513d6a-b452-449b-ae29-9797790ed569_5948584",
    "paymentMethod": "CREDIT_LINE"
  }
}
```

**Sample Response (Success):**
```json
{
  "data": {
    "confirmB2bBooking": {
      "accepted": true,
      "message": null
    }
  }
}
```

**Sample Response (Failure - not B2B):**
```json
{
  "data": {
    "confirmB2bBooking": {
      "accepted": false,
      "message": "User is not b2b user"
    }
  }
}
```

---

## 5. Booking Management

### 5.1 List Bookings

**Query:**
```graphql
query GetUserBookings($input: BookingListingInput!) {
  getUserBookings(input: $input) {
    bookings {
      id
      booking_id
      hotel_name
      hotel_id
      arrival_date
      nights
      status
      rooms_count
      created_on
      has_details
      isB2B
      hotel_photo
    }
  }
}
```

**Variables:**
```json
{
  "input": {
    "type": "UPCOMING"
  }
}
```

**Types:** `UPCOMING`, `COMPLETED`, `CANCELLED`, `PENDING`

**Sample Response:**
```json
{
  "data": {
    "getUserBookings": {
      "bookings": [
        {
          "id": "698341601f3796feeed6a790",
          "booking_id": "LT-2026-ABC123",
          "hotel_name": "The Kayon Jungle Resort",
          "hotel_id": "5948584",
          "arrival_date": "2026-08-23",
          "nights": 2,
          "status": "CONFIRMED",
          "rooms_count": 1,
          "created_on": "2026-02-04T10:30:00Z",
          "has_details": true,
          "isB2B": true,
          "hotel_photo": "https://images.locktrip.com/hotels/5948584/main.jpg"
        }
      ]
    }
  }
}
```

---

### 5.2 Get Booking Details

**Query:**
```graphql
query GetBookingDetails($bookingId: String!) {
  getBookingDetails(bookingId: $bookingId) {
    success
    data {
      bookingId
      bookingReferenceId
      providerReference
      status
      hotel {
        id
        name
        address
        city
        country
        phone
        email
        starRating
      }
      checkIn
      checkOut
      rooms {
        roomName
        mealType
        guests {
          firstName
          lastName
        }
        price
      }
      contactPerson {
        firstName
        lastName
        email
        phone
      }
      totalPrice
      currency
      paymentStatus
      cancellationPolicy {
        isRefundable
        freeCancellationUntil
        fees {
          fromDate
          amount
          currency
        }
      }
      specialRequests
      createdAt
      confirmedAt
    }
  }
}
```

**Variables:**
```json
{ "bookingId": "698341601f3796feeed6a790" }
```

**Sample Response:**
```json
{
  "data": {
    "getBookingDetails": {
      "success": true,
      "data": {
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
    }
  }
}
```

---

### 5.3 Cancel Booking

**Mutation:**
```graphql
mutation CancelBookingRequest($cancelBookingInput: CancelBookingInput!) {
  cancelBookingRequest(cancelBookingInput: $cancelBookingInput) {
    isCancellationRequested
  }
}
```

**Variables:**
```json
{
  "cancelBookingInput": {
    "bookingId": "698341601f3796feeed6a790",
    "confirmed": true
  }
}
```

**IMPORTANT:** Set `confirmed: true` to actually cancel. `false` is a dry-run.

**Sample Response:**
```json
{
  "data": {
    "cancelBookingRequest": {
      "isCancellationRequested": true
    }
  }
}
```

---

## 6. Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `0 results after 30 polls` | Polling too fast | Wait 2+ seconds before first poll |
| `Guest count mismatch` | Wrong adults count | Match exactly: 2 adults searched = 2 in booking |
| `User is not b2b user` | Account not B2B | Contact LockTrip for B2B account upgrade |
| `400 on cancellation policy` | Using full quoteId | Extract packageId: `quoteId.split('_')[0]` |
| `hotelId must be a number` | String hotelId | Use `parseInt(hotelId, 10)` for getHotelRooms |
| `Session expired` | Took too long | Restart from hotelSearch (session ~30 min) |
| `Invalid date format` | Wrong format | Use DD/MM/YYYY (e.g., "23/08/2026") |

---

## 7. Test Script

A complete E2E test script is available: `e2e-graphql-test.ts`

```bash
# Install dependencies
npm install axios typescript tsx

# Search only (safe - no charges):
BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts

# Full booking flow (CHARGES credit line, then cancels):
BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts --book
```

---

## Quick Reference

```
┌─────────────────────────────────────────────────────────────────────┐
│                    GRAPHQL API QUICK REFERENCE                       │
├─────────────────────────────────────────────────────────────────────┤
│ Date format:        DD/MM/YYYY (e.g., "23/08/2026")                 │
│ Page numbers:       1-based (1, 2, 3...)                            │
│ Completion field:   isResultCompleted === true                      │
│ hotelId type:       NUMBER for getHotelRooms                        │
│ packageId:          quoteId.split('_')[0]                           │
│ Guest structure:    rooms[].adults[] with title, firstName, lastName│
│ Guest count:        Must match search exactly                       │
│ First poll wait:    2+ seconds mandatory                            │
│ Total search time:  15-30 seconds typical                           │
│ Session lifetime:   ~30 minutes                                     │
├─────────────────────────────────────────────────────────────────────┤
│ FLOW: locationSearch → hotelSearch → WAIT 2s → hotelSearchResults   │
│       → getHotelRooms → hotelCancellationPolicies →                 │
│       hotelBookingPrepare → confirmB2bBooking                        │
│                                                                      │
│ MANAGE: getUserBookings → getBookingDetails → cancelBookingRequest  │
└─────────────────────────────────────────────────────────────────────┘
```

---

*Document version 2.1 - Complete B2B integration with sample responses*

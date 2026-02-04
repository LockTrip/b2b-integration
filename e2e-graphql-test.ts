/**
 * LockTrip GraphQL API - E2E Integration Test
 *
 * Complete hotel booking flow test using direct GraphQL API.
 * This script demonstrates the full B2B booking lifecycle.
 *
 * =============================================================================
 * AUTHENTICATION
 * =============================================================================
 *
 * 1. Get your Bearer token by logging into https://locktrip.com
 *    OR use the login API:
 *
 *    curl -X POST https://users.locktrip.com/api/auth/login \
 *      -H "Content-Type: application/json" \
 *      -d '{"email": "your-email@example.com", "password": "your-password"}'
 *
 * 2. Your account MUST be B2B with credit line:
 *    - isB2B: true
 *    - hasCL: true (has credit line)
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *
 * # Install dependencies (if not already installed)
 * npm install axios typescript tsx
 *
 * # Search only (no booking - safe to run):
 * BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts
 *
 * # Full flow with booking (CHARGES CREDIT LINE, then cancels):
 * BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts --book
 *
 * =============================================================================
 * FLOW
 * =============================================================================
 *
 * 1. locationSearch      → Get regionId
 * 2. hotelSearch         → Get searchKey (async, returns immediately)
 * 3. hotelSearchResults  → Poll until isResultCompleted=true
 * 4. getHotelRooms       → Get quoteId for selected room
 * 5. hotelCancellationPolicies → Check refund terms
 * 6. hotelBookingPrepare → Get preparedBookingId
 * 7. confirmB2bBooking   → Complete booking (CHARGES CREDIT LINE)
 * 8. cancelBookingRequest → Cancel and refund
 *
 * =============================================================================
 * KEY DIFFERENCES FROM MCP API
 * =============================================================================
 *
 * | Aspect           | GraphQL API      | MCP API          |
 * |------------------|------------------|------------------|
 * | Date format      | DD/MM/YYYY       | YYYY-MM-DD (ISO) |
 * | Page numbers     | 1-based          | 0-indexed        |
 * | hotelId type     | NUMBER           | String           |
 * | prepare_booking  | rooms[].adults[] | rooms[].guests[] |
 */

import axios from 'axios';

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  // Production GraphQL endpoint
  GRAPHQL_URL: 'https://locktrip.com',

  // Bearer token from environment (REQUIRED)
  // Get your token: https://locktrip.com or POST https://users.locktrip.com/api/auth/login
  BEARER_TOKEN: process.env.BEARER_TOKEN || '',

  // Search parameters - customize as needed
  DESTINATION: 'bali, indonesia',
  CURRENCY: 'EUR',
  ADULTS: 2,  // Guest count in booking MUST match this exactly
  MAX_PRICE_FILTER: 50,

  // Polling configuration
  POLL_INTERVAL_MS: 1000,
  POLL_MAX_ATTEMPTS: 30,
  POLL_INITIAL_WAIT_MS: 2000,

  // Test guest data - replace with real data for production
  GUESTS: [
    { title: 'Mr', firstName: 'John', lastName: 'Doe' },
    { title: 'Mrs', firstName: 'Jane', lastName: 'Doe' },
  ],
  CONTACT: {
    title: 'Mr',
    firstName: 'John',
    lastName: 'Doe',
    email: 'john.doe@example.com',
    phone: '+1234567890',
  },
};

// =============================================================================
// STATE
// =============================================================================
interface TestState {
  regionId: string;
  searchKey: string;
  hotelId: string;
  hotelName: string;
  quoteId: string;
  packageId: string;
  preparedBookingId: string;
  roomDetails: any;
  startDate: string;
  endDate: string;
  price: number;
}

const state: Partial<TestState> = {};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate test dates (6 months in future)
 * CRITICAL: GraphQL API uses DD/MM/YYYY format
 */
function getTestDates(): { startDate: string; endDate: string; display: string } {
  const checkIn = new Date();
  checkIn.setMonth(checkIn.getMonth() + 6);
  checkIn.setDate(checkIn.getDate() + Math.floor(Math.random() * 30));

  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);

  // DD/MM/YYYY format for GraphQL
  const format = (d: Date) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${d.getFullYear()}`;
  };

  return {
    startDate: format(checkIn),
    endDate: format(checkOut),
    display: `${checkIn.toDateString()} - ${checkOut.toDateString()}`,
  };
}

/**
 * Execute GraphQL query/mutation
 */
async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (CONFIG.BEARER_TOKEN) {
    headers['Authorization'] = CONFIG.BEARER_TOKEN.startsWith('Bearer ')
      ? CONFIG.BEARER_TOKEN
      : `Bearer ${CONFIG.BEARER_TOKEN}`;
  }

  const response = await axios.post(
    `${CONFIG.GRAPHQL_URL}/graphql`,
    { query, variables },
    { headers, timeout: 120000 }
  );

  if (response.data.errors) {
    console.error('GraphQL Errors:', JSON.stringify(response.data.errors, null, 2));
    throw new Error(`GraphQL error: ${response.data.errors[0]?.message}`);
  }

  return response.data.data;
}

function printStep(step: number, title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`STEP ${step}: ${title}`);
  console.log('='.repeat(70));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// STEP 1: Location Search
// =============================================================================
async function step1_locationSearch(): Promise<string> {
  printStep(1, 'locationSearch');

  const query = `
    query LocationSearch($query: String!) {
      locationSearch(query: $query) {
        locationData
      }
    }
  `;

  console.log(`Searching for: "${CONFIG.DESTINATION}"`);

  const result = await graphql<{ locationSearch: { locationData: any[] } }>(
    query,
    { query: CONFIG.DESTINATION }
  );

  const locations = result.locationSearch.locationData;
  if (!locations || locations.length === 0) {
    throw new Error(`No locations found for: ${CONFIG.DESTINATION}`);
  }

  const location = locations[0];
  state.regionId = location.id;

  console.log(`Found: ${location.name || location.query || 'Location'}`);
  console.log(`Region ID: ${state.regionId}`);

  return state.regionId;
}

// =============================================================================
// STEP 2: Hotel Search
// =============================================================================
async function step2_hotelSearch(): Promise<string> {
  printStep(2, 'hotelSearch');

  const dates = getTestDates();
  state.startDate = dates.startDate;
  state.endDate = dates.endDate;

  console.log(`Dates: ${dates.display}`);
  console.log(`API Format: ${dates.startDate} - ${dates.endDate} (DD/MM/YYYY)`);
  console.log(`Adults: ${CONFIG.ADULTS}`);
  console.log(`Currency: ${CONFIG.CURRENCY}`);

  const query = `
    mutation HotelSearch($searchHotelsInput: searchHotelsInput!, $isAsyncSearch: Boolean) {
      hotelSearch(searchHotelsInput: $searchHotelsInput, isAsyncSearch: $isAsyncSearch) {
        searchKey
        sessionId
      }
    }
  `;

  const result = await graphql<{ hotelSearch: { searchKey: string; sessionId: string } }>(
    query,
    {
      searchHotelsInput: {
        regionId: state.regionId,
        startDate: state.startDate,
        endDate: state.endDate,
        currency: CONFIG.CURRENCY,
        rooms: [{ adults: CONFIG.ADULTS, children: [] }],
        uuid: `test-${Date.now()}`,
        nat: '',
      },
      isAsyncSearch: true,
    }
  );

  state.searchKey = result.hotelSearch.searchKey;

  console.log(`Search Key: ${state.searchKey}`);
  console.log(`Session ID: ${result.hotelSearch.sessionId}`);

  return state.searchKey;
}

// =============================================================================
// STEP 3: Get Search Results (Poll until complete)
// =============================================================================
async function step3_getSearchResults(): Promise<any[]> {
  printStep(3, 'hotelSearchResults (polling)');

  console.log(`Waiting ${CONFIG.POLL_INITIAL_WAIT_MS}ms before first poll...`);
  console.log(`(Empty results at start is NORMAL - search is async)`);
  await sleep(CONFIG.POLL_INITIAL_WAIT_MS);

  const query = `
    query HotelSearchResults($input: SearchResultsInput!) {
      hotelSearchResults(input: $input) {
        results {
          externalId
          name
          star
          price
          address
          hasFreeCancellationOption
          reviews { scoreSummary reviewsCount }
        }
        totalResults
        isResultCompleted
        hasNextPage
      }
    }
  `;

  let isCompleted = false;
  let attempts = 0;
  let hotels: any[] = [];

  while (!isCompleted && attempts < CONFIG.POLL_MAX_ATTEMPTS) {
    const result = await graphql<{ hotelSearchResults: any }>(query, {
      input: {
        searchKey: state.searchKey,
        page: 1,  // GraphQL uses 1-based pagination
        size: 100,
        filters: {},
        sortParams: ['price', 'asc'],
        singleHotelId: 0,
      },
    });

    isCompleted = result.hotelSearchResults.isResultCompleted;
    hotels = result.hotelSearchResults.results || [];

    console.log(
      `Poll ${attempts + 1}/${CONFIG.POLL_MAX_ATTEMPTS}: ` +
      `completed=${isCompleted}, results=${hotels.length}, total=${result.hotelSearchResults.totalResults}`
    );

    if (!isCompleted) {
      await sleep(CONFIG.POLL_INTERVAL_MS);
    }
    attempts++;
  }

  console.log(`\nSearch complete: ${hotels.length} hotels found`);

  // Filter for hotels under max price
  const eligible = hotels.filter(h => h.price <= CONFIG.MAX_PRICE_FILTER);
  console.log(`Hotels under €${CONFIG.MAX_PRICE_FILTER}: ${eligible.length}`);

  if (eligible.length > 0) {
    const selected = eligible[0];
    state.hotelId = String(selected.externalId);
    state.hotelName = selected.name;
    state.price = selected.price;
    console.log(`\nSelected: ${selected.name}`);
    console.log(`  Hotel ID: ${state.hotelId}`);
    console.log(`  Price: €${selected.price}`);
    console.log(`  Stars: ${selected.star}`);
  } else if (hotels.length > 0) {
    const selected = hotels[0];
    state.hotelId = String(selected.externalId);
    state.hotelName = selected.name;
    state.price = selected.price;
    console.log(`\nUsing first available: ${selected.name}`);
  } else {
    throw new Error('No hotels found');
  }

  return hotels;
}

// =============================================================================
// STEP 4: Get Hotel Rooms
// =============================================================================
async function step4_getHotelRooms(): Promise<any[]> {
  printStep(4, 'getHotelRooms');

  console.log(`Hotel: ${state.hotelName}`);

  const query = `
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
        }
      }
    }
  `;

  const result = await graphql<{ getHotelRooms: any }>(query, {
    input: {
      searchKey: state.searchKey,
      hotelId: parseInt(state.hotelId!, 10),  // MUST be number for GraphQL
      startDate: state.startDate,
      endDate: state.endDate,
      regionId: state.regionId,
      rooms: [{ adults: CONFIG.ADULTS, children: [] }],
      currency: CONFIG.CURRENCY,
      nat: null,
    },
  });

  // Update searchKey if returned
  if (result.getHotelRooms.searchKey) {
    state.searchKey = result.getHotelRooms.searchKey;
    console.log(`Updated searchKey: ${state.searchKey}`);
  }

  const rooms = result.getHotelRooms.hotelRoomsResponse || [];
  console.log(`Found ${rooms.length} room packages`);

  // Prefer refundable rooms
  const refundable = rooms.filter((r: any) => r.refundable === true);
  console.log(`Refundable: ${refundable.length}`);

  const selected = refundable.length > 0 ? refundable[0] : rooms[0];

  if (!selected) {
    throw new Error('No room packages available');
  }

  state.quoteId = selected.quoteId;
  state.packageId = state.quoteId.split('_')[0];  // Extract packageId from quoteId
  state.roomDetails = selected;
  state.price = selected.finalPrice;

  console.log(`\nSelected Room:`);
  console.log(`  Quote ID: ${state.quoteId}`);
  console.log(`  Package ID: ${state.packageId}`);
  console.log(`  Type: ${selected.roomType || selected.originalName}`);
  console.log(`  Meal: ${selected.mealType}`);
  console.log(`  Price: €${selected.finalPrice}`);
  console.log(`  Refundable: ${selected.refundable}`);

  return rooms;
}

// =============================================================================
// STEP 5: Check Cancellation Policy
// =============================================================================
async function step5_checkCancellationPolicy(): Promise<any> {
  printStep(5, 'hotelCancellationPolicies');

  console.log(`Package ID: ${state.packageId}`);
  console.log(`(Extracted from quoteId.split('_')[0])`);

  const query = `
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
        cancellations {
          nonRefundable
          boardType
          canxFees {
            amount { amt }
            from
          }
        }
      }
    }
  `;

  const result = await graphql<{ hotelCancellationPolicies: any[] }>(query, {
    searchKey: state.searchKey,
    hotelId: state.hotelId,
    packageIds: [state.packageId],  // Use packageId, NOT full quoteId
  });

  const policy = result.hotelCancellationPolicies[0];
  const cancellation = policy?.cancellations?.[0];

  console.log(`Non-Refundable: ${cancellation?.nonRefundable}`);

  if (cancellation?.canxFees?.length > 0) {
    console.log(`Cancellation Fees:`);
    cancellation.canxFees.forEach((fee: any, i: number) => {
      const fromDate = fee.from ? new Date(fee.from).toISOString().split('T')[0] : 'N/A';
      console.log(`  ${i + 1}. From ${fromDate}: €${fee.amount?.amt || 0}`);
    });
  }

  return policy;
}

// =============================================================================
// STEP 6: Prepare Booking
// =============================================================================
async function step6_prepareBooking(): Promise<string> {
  printStep(6, 'hotelBookingPrepare');

  if (!CONFIG.BEARER_TOKEN) {
    console.log('SKIPPED: No Bearer token');
    return '';
  }

  console.log(`Guests: ${CONFIG.GUESTS.map(g => `${g.firstName} ${g.lastName}`).join(', ')}`);
  console.log(`Contact: ${CONFIG.CONTACT.email}`);
  console.log(`Quote ID: ${state.quoteId}`);

  const query = `
    mutation HotelBookingPrepare($bookingCreateInput: BookingCreateInput!) {
      hotelBookingPrepare(bookingCreateInput: $bookingCreateInput) {
        preparedBookingId
        fiatPrice
        currency
        payment
      }
    }
  `;

  // GraphQL uses rooms[].adults[] structure (NOT rooms[].guests[])
  const result = await graphql<{ hotelBookingPrepare: any }>(query, {
    bookingCreateInput: {
      quoteId: state.quoteId,
      rooms: [{
        adults: CONFIG.GUESTS.slice(0, CONFIG.ADULTS).map(g => ({
          title: g.title,
          firstName: g.firstName,
          lastName: g.lastName,
        })),
        children: [],
      }],
      contactPerson: {
        title: CONFIG.CONTACT.title,
        firstName: CONFIG.CONTACT.firstName,
        lastName: CONFIG.CONTACT.lastName,
        email: CONFIG.CONTACT.email,
        phone: CONFIG.CONTACT.phone,
      },
    },
  });

  state.preparedBookingId = result.hotelBookingPrepare.preparedBookingId;

  console.log(`\n✅ Booking Prepared!`);
  console.log(`  Booking ID: ${state.preparedBookingId}`);
  console.log(`  Price: €${result.hotelBookingPrepare.fiatPrice} ${result.hotelBookingPrepare.currency}`);
  console.log(`  Payment: ${result.hotelBookingPrepare.payment}`);

  return state.preparedBookingId;
}

// =============================================================================
// STEP 7: Confirm B2B Booking
// =============================================================================
async function step7_confirmBooking(): Promise<boolean> {
  printStep(7, 'confirmB2bBooking');

  if (!state.preparedBookingId) {
    console.log('SKIPPED: No prepared booking');
    return false;
  }

  console.log(`Booking ID: ${state.preparedBookingId}`);
  console.log(`Payment: CREDIT_LINE`);
  console.log(`\n⚠️  THIS WILL CHARGE YOUR CREDIT LINE`);

  const query = `
    mutation ConfirmB2bBooking($bookingConfirmInput: BookingConfirmInput!) {
      confirmB2bBooking(bookingConfirmInput: $bookingConfirmInput) {
        accepted
        message
      }
    }
  `;

  const result = await graphql<{ confirmB2bBooking: { accepted: boolean; message: string | null } }>(
    query,
    {
      bookingConfirmInput: {
        bookingInternalId: state.preparedBookingId,
        quoteId: state.quoteId,
        paymentMethod: 'CREDIT_LINE',
      },
    }
  );

  if (result.confirmB2bBooking.accepted) {
    console.log(`\n🎉 BOOKING CONFIRMED!`);
    console.log(`  Booking ID: ${state.preparedBookingId}`);
  } else {
    console.log(`\n❌ BOOKING FAILED`);
    console.log(`  Message: ${result.confirmB2bBooking.message}`);
  }

  return result.confirmB2bBooking.accepted;
}

// =============================================================================
// STEP 8: Cancel Booking
// =============================================================================
async function step8_cancelBooking(): Promise<boolean> {
  printStep(8, 'cancelBookingRequest');

  if (!state.preparedBookingId) {
    console.log('SKIPPED: No booking');
    return false;
  }

  console.log(`Cancelling: ${state.preparedBookingId}`);

  const query = `
    mutation CancelBookingRequest($cancelBookingInput: CancelBookingInput!) {
      cancelBookingRequest(cancelBookingInput: $cancelBookingInput) {
        isCancellationRequested
      }
    }
  `;

  const result = await graphql<{ cancelBookingRequest: { isCancellationRequested: boolean } }>(
    query,
    {
      cancelBookingInput: {
        bookingId: state.preparedBookingId,
        confirmed: true,
      },
    }
  );

  if (result.cancelBookingRequest.isCancellationRequested) {
    console.log(`\n✅ BOOKING CANCELLED!`);
  } else {
    console.log(`\n❌ CANCELLATION FAILED`);
  }

  return result.cancelBookingRequest.isCancellationRequested;
}

// =============================================================================
// SUMMARY
// =============================================================================
function printSummary() {
  console.log(`\n${'='.repeat(70)}`);
  console.log('GRAPHQL E2E TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`API URL:              ${CONFIG.GRAPHQL_URL}/graphql`);
  console.log(`Region ID:            ${state.regionId || 'N/A'}`);
  console.log(`Search Key:           ${state.searchKey || 'N/A'}`);
  console.log(`Hotel:                ${state.hotelName || 'N/A'} (${state.hotelId || 'N/A'})`);
  console.log(`Quote ID:             ${state.quoteId || 'N/A'}`);
  console.log(`Package ID:           ${state.packageId || 'N/A'}`);
  console.log(`Booking ID:           ${state.preparedBookingId || 'N/A'}`);
  console.log(`Check-in:             ${state.startDate || 'N/A'} (DD/MM/YYYY)`);
  console.log(`Check-out:            ${state.endDate || 'N/A'}`);
  console.log(`Price:                €${state.price || 'N/A'}`);
  console.log('='.repeat(70));
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║         LOCKTRIP GRAPHQL API - E2E INTEGRATION TEST                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  console.log(`API URL: ${CONFIG.GRAPHQL_URL}/graphql`);
  console.log(`Token:   ${CONFIG.BEARER_TOKEN ? '✓ Provided' : '✗ NOT PROVIDED'}`);

  if (!CONFIG.BEARER_TOKEN) {
    console.error('\n❌ ERROR: BEARER_TOKEN environment variable is required');
    console.error('\nHow to get your token:');
    console.error('  1. Login at https://locktrip.com');
    console.error('  2. Or POST https://users.locktrip.com/api/auth/login');
    console.error('\nUsage:');
    console.error('  BEARER_TOKEN="eyJ..." npx tsx e2e-graphql-test.ts');
    process.exit(1);
  }

  const doBooking = process.argv.includes('--book');

  if (doBooking) {
    console.log('\n⚠️  BOOKING MODE: Will charge credit line (then cancel)');
  } else {
    console.log('\n📋 SEARCH MODE: Safe to run (no charges)');
    console.log('   Add --book flag to test full booking flow');
  }

  try {
    await step1_locationSearch();
    await step2_hotelSearch();
    await step3_getSearchResults();
    await step4_getHotelRooms();
    await step5_checkCancellationPolicy();

    if (doBooking) {
      await step6_prepareBooking();
      const confirmed = await step7_confirmBooking();

      if (confirmed) {
        console.log('\n⏳ Waiting 3s before cancellation...');
        await sleep(3000);
        await step8_cancelBooking();
      }
    }

    printSummary();
    console.log('\n✅ TEST COMPLETED SUCCESSFULLY!\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', (error as Error).message);
    printSummary();
    process.exit(1);
  }
}

main();

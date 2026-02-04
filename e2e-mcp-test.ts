/**
 * LockTrip MCP Server - E2E Integration Test
 *
 * Complete hotel booking flow test using MCP Server endpoints.
 * This script demonstrates the full B2B booking lifecycle via MCP.
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
 * BEARER_TOKEN="eyJ..." npx tsx e2e-mcp-test.ts
 *
 * # Full flow with booking (CHARGES CREDIT LINE, then cancels):
 * BEARER_TOKEN="eyJ..." npx tsx e2e-mcp-test.ts --book
 *
 * =============================================================================
 * MCP ENDPOINTS
 * =============================================================================
 *
 * Base URL: https://locktrip.com/mcp
 *
 * | Endpoint          | Method | Description              |
 * |-------------------|--------|--------------------------|
 * | /health           | GET    | Health check             |
 * | /tools            | GET    | List available tools     |
 * | /tools/:name      | POST   | Call a tool directly     |
 * | /rpc              | POST   | JSON-RPC 2.0 endpoint    |
 * | /sse              | GET    | SSE stream for MCP       |
 *
 * =============================================================================
 * FLOW
 * =============================================================================
 *
 * 1. search_location         → Get regionId
 * 2. hotel_search            → Get searchKey
 * 3. get_search_results      → Poll until searchStatus=COMPLETED
 * 4. get_hotel_rooms         → Get quoteId
 * 5. check_cancellation_policy → Check refund terms
 * 6. prepare_booking         → Get bookingInternalId
 * 7. confirm_booking         → Complete booking (CHARGES CREDIT LINE)
 * 8. cancel_booking          → Cancel and refund
 *
 * =============================================================================
 * KEY DIFFERENCES FROM GRAPHQL API
 * =============================================================================
 *
 * | Aspect           | MCP API          | GraphQL API      |
 * |------------------|------------------|------------------|
 * | Date format      | YYYY-MM-DD (ISO) | DD/MM/YYYY       |
 * | Page numbers     | 0-indexed        | 1-based          |
 * | hotelId type     | String           | NUMBER           |
 * | prepare_booking  | rooms[].guests[] | rooms[].adults[] |
 */

import axios, { AxiosError } from 'axios';

// =============================================================================
// CONFIGURATION
// =============================================================================
const CONFIG = {
  // Production MCP endpoint
  MCP_BASE_URL: 'https://locktrip.com/mcp',

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
    { firstName: 'John', lastName: 'Doe' },
    { firstName: 'Jane', lastName: 'Doe' },
  ],
  CONTACT: {
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
 * MCP API uses YYYY-MM-DD (ISO) format
 */
function getTestDates(): { startDate: string; endDate: string; display: string } {
  const checkIn = new Date();
  checkIn.setMonth(checkIn.getMonth() + 6);
  checkIn.setDate(checkIn.getDate() + Math.floor(Math.random() * 30));

  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 1);

  // ISO format YYYY-MM-DD for MCP
  const format = (d: Date) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  return {
    startDate: format(checkIn),
    endDate: format(checkOut),
    display: `${checkIn.toDateString()} - ${checkOut.toDateString()}`,
  };
}

/**
 * Call MCP tool endpoint
 */
async function mcpTool<T>(toolName: string, input: Record<string, unknown>): Promise<T> {
  const url = `${CONFIG.MCP_BASE_URL}/tools/${toolName}`;

  try {
    const response = await axios.post(url, input, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': CONFIG.BEARER_TOKEN.startsWith('Bearer ')
          ? CONFIG.BEARER_TOKEN
          : `Bearer ${CONFIG.BEARER_TOKEN}`,
      },
      timeout: 120000,
    });

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;
      console.error(`MCP Error [${toolName}]:`, axiosError.response?.data || axiosError.message);
      throw new Error(`MCP tool ${toolName} failed: ${JSON.stringify(axiosError.response?.data)}`);
    }
    throw error;
  }
}

function printStep(step: number, title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`STEP ${step}: ${title}`);
  console.log('='.repeat(70));
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// =============================================================================
// STEP 1: Search Location
// =============================================================================
async function step1_searchLocation(): Promise<string> {
  printStep(1, 'search_location');

  console.log(`Searching for: "${CONFIG.DESTINATION}"`);

  const result = await mcpTool<{ locations: Array<{ id: string; name: string; type: string }> }>(
    'search_location',
    { query: CONFIG.DESTINATION }
  );

  if (!result.locations || result.locations.length === 0) {
    throw new Error(`No locations found for: ${CONFIG.DESTINATION}`);
  }

  const location = result.locations[0];
  state.regionId = location.id;

  console.log(`Found: ${location.name} (${location.type})`);
  console.log(`Region ID: ${state.regionId}`);

  return state.regionId;
}

// =============================================================================
// STEP 2: Hotel Search
// =============================================================================
async function step2_hotelSearch(): Promise<string> {
  printStep(2, 'hotel_search');

  const dates = getTestDates();
  state.startDate = dates.startDate;
  state.endDate = dates.endDate;

  console.log(`Dates: ${dates.display}`);
  console.log(`API Format: ${dates.startDate} - ${dates.endDate} (YYYY-MM-DD)`);
  console.log(`Adults: ${CONFIG.ADULTS}`);
  console.log(`Currency: ${CONFIG.CURRENCY}`);

  const result = await mcpTool<{ searchKey: string; sessionId: string }>(
    'hotel_search',
    {
      regionId: state.regionId,
      startDate: state.startDate,
      endDate: state.endDate,
      currency: CONFIG.CURRENCY,
      rooms: [{ adults: CONFIG.ADULTS, childrenAges: [] }],
      nationality: 'US',
    }
  );

  state.searchKey = result.searchKey;

  console.log(`Search Key: ${state.searchKey}`);
  console.log(`Session ID: ${result.sessionId}`);

  return state.searchKey;
}

// =============================================================================
// STEP 3: Get Search Results (Poll until complete)
// =============================================================================
async function step3_getSearchResults(): Promise<any[]> {
  printStep(3, 'get_search_results (polling)');

  console.log(`Waiting ${CONFIG.POLL_INITIAL_WAIT_MS}ms before first poll...`);
  console.log(`(Empty results at start is NORMAL - search is async)`);
  await sleep(CONFIG.POLL_INITIAL_WAIT_MS);

  let isCompleted = false;
  let attempts = 0;
  let hotels: any[] = [];

  while (!isCompleted && attempts < CONFIG.POLL_MAX_ATTEMPTS) {
    const result = await mcpTool<{
      hotels: any[];
      totalCount: number;
      searchStatus: string;
    }>('get_search_results', {
      searchKey: state.searchKey,
      page: 0,       // MCP uses 0-indexed pagination
      size: 5000,    // Get all results, filter locally
      sortBy: 'PRICE_ASC',
      filters: {},
    });

    isCompleted = result.searchStatus === 'COMPLETED';
    hotels = result.hotels || [];

    console.log(
      `Poll ${attempts + 1}/${CONFIG.POLL_MAX_ATTEMPTS}: ` +
      `status=${result.searchStatus}, results=${hotels.length}, total=${result.totalCount}`
    );

    if (!isCompleted && hotels.length === 0) {
      await sleep(CONFIG.POLL_INTERVAL_MS);
    } else if (hotels.length > 0) {
      break;
    }
    attempts++;
  }

  console.log(`\nSearch complete: ${hotels.length} hotels found`);

  // Filter for hotels under max price
  const eligible = hotels.filter(h => h.minPrice <= CONFIG.MAX_PRICE_FILTER);
  console.log(`Hotels under €${CONFIG.MAX_PRICE_FILTER}: ${eligible.length}`);

  if (eligible.length > 0) {
    const selected = eligible[0];
    state.hotelId = selected.hotelId;
    state.hotelName = selected.name;
    state.price = selected.minPrice;
    console.log(`\nSelected: ${selected.name}`);
    console.log(`  Hotel ID: ${state.hotelId}`);
    console.log(`  Price: €${selected.minPrice}`);
    console.log(`  Stars: ${selected.starRating}`);
  } else if (hotels.length > 0) {
    const selected = hotels[0];
    state.hotelId = selected.hotelId;
    state.hotelName = selected.name;
    state.price = selected.minPrice;
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
  printStep(4, 'get_hotel_rooms');

  console.log(`Hotel: ${state.hotelName}`);

  const result = await mcpTool<{
    hotelId: string;
    packages: Array<{
      quoteId: string;
      roomName: string;
      mealType: string;
      price: number;
      isRefundable: boolean;
    }>;
  }>('get_hotel_rooms', {
    hotelId: state.hotelId,  // MCP accepts string
    searchKey: state.searchKey,
    startDate: state.startDate,
    endDate: state.endDate,
    rooms: [{ adults: CONFIG.ADULTS, childrenAges: [] }],
    nationality: 'US',
    regionId: state.regionId,
    currency: CONFIG.CURRENCY,
  });

  const packages = result.packages || [];
  console.log(`Found ${packages.length} room packages`);

  // Prefer refundable rooms
  const refundable = packages.filter(p => p.isRefundable === true);
  console.log(`Refundable: ${refundable.length}`);

  const selected = refundable.length > 0 ? refundable[0] : packages[0];

  if (!selected) {
    throw new Error('No room packages available');
  }

  state.quoteId = selected.quoteId;
  state.packageId = selected.quoteId.split('_')[0];
  state.roomDetails = selected;
  state.price = selected.price;

  console.log(`\nSelected Room:`);
  console.log(`  Quote ID: ${state.quoteId}`);
  console.log(`  Package ID: ${state.packageId}`);
  console.log(`  Room: ${selected.roomName}`);
  console.log(`  Meal: ${selected.mealType}`);
  console.log(`  Price: €${selected.price}`);
  console.log(`  Refundable: ${selected.isRefundable}`);

  return packages;
}

// =============================================================================
// STEP 5: Check Cancellation Policy
// =============================================================================
async function step5_checkCancellationPolicy(): Promise<any> {
  printStep(5, 'check_cancellation_policy');

  console.log(`Package ID: ${state.packageId}`);
  console.log(`(Extracted from quoteId.split('_')[0])`);

  const result = await mcpTool<{
    hotelId: string;
    policies: Array<{
      packageId: string;
      isRefundable: boolean;
      freeCancellationUntil?: string;
      fees: Array<{ fromDate: string; amount: number; currency: string }>;
    }>;
  }>('check_cancellation_policy', {
    searchKey: state.searchKey,
    hotelId: state.hotelId,
    packageIds: [state.packageId],
  });

  const policy = result.policies?.[0];

  if (policy) {
    console.log(`Refundable: ${policy.isRefundable}`);
    console.log(`Free cancellation until: ${policy.freeCancellationUntil || 'N/A'}`);

    if (policy.fees?.length > 0) {
      console.log(`Cancellation fees:`);
      policy.fees.forEach((fee, i) => {
        console.log(`  ${i + 1}. From ${fee.fromDate}: €${fee.amount}`);
      });
    }
  }

  return policy;
}

// =============================================================================
// STEP 6: Prepare Booking
// =============================================================================
async function step6_prepareBooking(): Promise<string> {
  printStep(6, 'prepare_booking');

  if (!CONFIG.BEARER_TOKEN) {
    console.log('SKIPPED: No Bearer token');
    return '';
  }

  console.log(`Guests: ${CONFIG.GUESTS.map(g => `${g.firstName} ${g.lastName}`).join(', ')}`);
  console.log(`Contact: ${CONFIG.CONTACT.email}`);
  console.log(`Quote ID: ${state.quoteId}`);

  // MCP uses rooms[].guests[] structure (NOT rooms[].adults[])
  const result = await mcpTool<{
    bookingInternalId: string;
    price: number;
    currency: string;
  }>('prepare_booking', {
    quoteId: state.quoteId,
    rooms: [{
      roomIndex: 0,
      guests: CONFIG.GUESTS.slice(0, CONFIG.ADULTS).map((g, i) => ({
        firstName: g.firstName,
        lastName: g.lastName,
        isLeadGuest: i === 0,
      })),
    }],
    contactPerson: CONFIG.CONTACT,
  });

  state.preparedBookingId = result.bookingInternalId;

  console.log(`\n✅ Booking Prepared!`);
  console.log(`  Booking ID: ${state.preparedBookingId}`);
  console.log(`  Price: €${result.price} ${result.currency}`);

  return state.preparedBookingId;
}

// =============================================================================
// STEP 7: Confirm B2B Booking
// =============================================================================
async function step7_confirmBooking(): Promise<boolean> {
  printStep(7, 'confirm_booking');

  if (!state.preparedBookingId) {
    console.log('SKIPPED: No prepared booking');
    return false;
  }

  console.log(`Booking ID: ${state.preparedBookingId}`);
  console.log(`Payment: CREDIT_LINE`);
  console.log(`\n⚠️  THIS WILL CHARGE YOUR CREDIT LINE`);

  const result = await mcpTool<{
    accepted: boolean;
    message?: string;
  }>('confirm_booking', {
    bookingInternalId: state.preparedBookingId,
    quoteId: state.quoteId,
    paymentMethod: 'CREDIT_LINE',
  });

  if (result.accepted) {
    console.log(`\n🎉 BOOKING CONFIRMED!`);
    console.log(`  Booking ID: ${state.preparedBookingId}`);
  } else {
    console.log(`\n❌ BOOKING FAILED`);
    console.log(`  Message: ${result.message}`);
  }

  return result.accepted;
}

// =============================================================================
// STEP 8: Cancel Booking
// =============================================================================
async function step8_cancelBooking(): Promise<boolean> {
  printStep(8, 'cancel_booking');

  if (!state.preparedBookingId) {
    console.log('SKIPPED: No booking');
    return false;
  }

  console.log(`Cancelling: ${state.preparedBookingId}`);

  const result = await mcpTool<{
    success: boolean;
    message: string;
  }>('cancel_booking', {
    bookingId: state.preparedBookingId,
    confirmed: true,
  });

  if (result.success) {
    console.log(`\n✅ BOOKING CANCELLED!`);
    console.log(`  Message: ${result.message}`);
  } else {
    console.log(`\n❌ CANCELLATION FAILED`);
    console.log(`  Message: ${result.message}`);
  }

  return result.success;
}

// =============================================================================
// SUMMARY
// =============================================================================
function printSummary() {
  console.log(`\n${'='.repeat(70)}`);
  console.log('MCP E2E TEST SUMMARY');
  console.log('='.repeat(70));
  console.log(`MCP URL:              ${CONFIG.MCP_BASE_URL}`);
  console.log(`Region ID:            ${state.regionId || 'N/A'}`);
  console.log(`Search Key:           ${state.searchKey || 'N/A'}`);
  console.log(`Hotel:                ${state.hotelName || 'N/A'} (${state.hotelId || 'N/A'})`);
  console.log(`Quote ID:             ${state.quoteId || 'N/A'}`);
  console.log(`Package ID:           ${state.packageId || 'N/A'}`);
  console.log(`Booking ID:           ${state.preparedBookingId || 'N/A'}`);
  console.log(`Check-in:             ${state.startDate || 'N/A'} (YYYY-MM-DD)`);
  console.log(`Check-out:            ${state.endDate || 'N/A'}`);
  console.log(`Price:                €${state.price || 'N/A'}`);
  console.log('='.repeat(70));
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║           LOCKTRIP MCP SERVER - E2E INTEGRATION TEST                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  console.log(`MCP URL: ${CONFIG.MCP_BASE_URL}`);
  console.log(`Token:   ${CONFIG.BEARER_TOKEN ? '✓ Provided' : '✗ NOT PROVIDED'}`);

  if (!CONFIG.BEARER_TOKEN) {
    console.error('\n❌ ERROR: BEARER_TOKEN environment variable is required');
    console.error('\nHow to get your token:');
    console.error('  1. Login at https://locktrip.com');
    console.error('  2. Or POST https://users.locktrip.com/api/auth/login');
    console.error('\nUsage:');
    console.error('  BEARER_TOKEN="eyJ..." npx tsx e2e-mcp-test.ts');
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
    await step1_searchLocation();
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

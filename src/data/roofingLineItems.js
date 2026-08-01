// Master list of Roofing job type line items. Single source of truth for:
//   - the Roofing job type's default invoice line items (seeded/migrated into
//     appConfig/jobTypes via ensureFirestoreData)
//   - the "Add Line Item" picker modal on InvoiceScreen
//
// Bid items have no fixed price — unitPrice starts at 0 and isBid marks them
// so the UI shows "Bid" instead of "$0.00" until a real price is entered.
// Every item defaults to qty 0; the user enters quantity when building an
// invoice.

export const ROOFING_LINE_ITEMS = [
  { description: 'R & R (1) Layer Asphalt',          unit: 'SQ', unitPrice: 80,  isBid: false },
  { description: 'Install Luxury Asphalt',            unit: 'SQ', unitPrice: 110, isBid: false },
  { description: 'Install Modified Bitumen',          unit: 'SQ', unitPrice: 100, isBid: false },
  { description: 'Install DeVinci',                   unit: 'SQ', unitPrice: 150, isBid: false },
  { description: 'Install Decra',                     unit: 'SQ', unitPrice: 0,   isBid: true  },
  { description: 'Remove Wood Shake',                 unit: 'SQ', unitPrice: 0,   isBid: true  },
  { description: 'Extra Layer Tear-Off',               unit: 'SQ', unitPrice: 15,  isBid: false },
  { description: '8/12 Steep Add-On',                  unit: 'SQ', unitPrice: 5,   isBid: false },
  { description: '9/12 Steep Add-On',                  unit: 'SQ', unitPrice: 10,  isBid: false },
  { description: '10/12 Steep Add-On',                 unit: 'SQ', unitPrice: 15,  isBid: false },
  { description: '11/12 Steep Add-On',                 unit: 'SQ', unitPrice: 20,  isBid: false },
  { description: '12/12 Steep Add-On',                 unit: 'SQ', unitPrice: 25,  isBid: false },
  { description: '13/12 Steep Add-On',                 unit: 'SQ', unitPrice: 30,  isBid: false },
  { description: '14/12-16/12 Steep Add-On',           unit: 'SQ', unitPrice: 40,  isBid: false },
  { description: '16/12 Mansard Steep Add-On',         unit: 'SQ', unitPrice: 50,  isBid: false },
  { description: 'Re-Deck over Space Decking w/ OSB',  unit: 'SQ', unitPrice: 45,  isBid: false },
  { description: 'Cut-In Roof Vent (ea. Access)',      unit: 'EA', unitPrice: 10,  isBid: false },
  { description: 'Install Ridge-Vent',                 unit: 'LF', unitPrice: 2,   isBid: false },
  { description: 'Hand Load Shingles (per Bundle)',    unit: 'EA', unitPrice: 2.5, isBid: false },
  { description: 'No Dump Access',                     unit: 'SQ', unitPrice: 15,  isBid: false },
  { description: 'Dump Fee Total Cost',                unit: 'EA', unitPrice: 469, isBid: false },
  { description: 'Replace Sheathing (rotten)',         unit: 'EA', unitPrice: 15,  isBid: false },
  { description: 'Install Skylight',                   unit: 'EA', unitPrice: 150, isBid: false },
  { description: 'Re-Flash Skylight',                  unit: 'EA', unitPrice: 75,  isBid: false },
  { description: 'Re-flash Chimney (small)',           unit: 'EA', unitPrice: 100, isBid: false },
  { description: 'Re-flash Chimney (large)',           unit: 'EA', unitPrice: 150, isBid: false },
  { description: 'Material Trip Charge',               unit: 'EA', unitPrice: 50,  isBid: false },
  { description: 'Destination Fee',                    unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: '2 Story Per sq',                     unit: 'SQ', unitPrice: 10,  isBid: false },
  { description: 'Install Cricket',                    unit: 'EA', unitPrice: 200, isBid: false },
  { description: 'Install Snowpan',                    unit: 'EA', unitPrice: 150, isBid: false },
  { description: 'Remove all shingles down to deck',   unit: 'SQ', unitPrice: 0,   isBid: true  },
  { description: 'Remove extra layer of papers',       unit: 'EA', unitPrice: 5,   isBid: false },
  { description: 'Install new gutter aprons',          unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Install new drip edge',               unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Install two rows ice and water',     unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Install new valley',                  unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Install synthetic paper',             unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Clean up and haul away all debris',  unit: 'EA', unitPrice: 0,   isBid: true  },
  { description: 'Permit Fee',                          unit: 'EA', unitPrice: 0,   isBid: true  },
].map((item) => ({ ...item, qty: 0 }));

namespace juno_invoice_assistant_v1;

using {
  cuid,
  managed
} from '@sap/cds/common';

// ============================================
// INVOICE HEADER
// ============================================
@assert.unique: {correlationId: [correlationId]}
entity InvoiceHeader : cuid, managed {
  // --- Integration IDs ---
  correlationId          : String(80)  @title: 'Correlation ID';
  messageId              : String(80)  @title: 'Message ID';

  // --- Processing State ---
  step                   : String(40)  @title: 'Current Step'; 
  // RECEIVED, DOX_EXTRACTED, SUPPLIER_MATCHED, PO_MATCHED, READY_FOR_APPROVAL, APPROVED, POSTED, REJECTED, ERROR
  
  status                 : String(20)  @title: 'Status' default 'NEW'; 
  // NEW, IN_PROGRESS, COMPLETED, ERROR, MANUAL_REVIEW
  
  result                 : String(20)  @title: 'Result'; 
  // SUCCESS, FAILURE, PARTIAL, PENDING
  
  message                : String(500) @title: 'Status Message';
  sourceSystem           : String(20)  @title: 'Source System';
  modifiedDate           : Timestamp   @cds.on.update: $now;
  modifiedBy             : String(100);

  // --- Document Information ---
  fileName               : String(255) @title: 'PDF File Name';
  pdfUrl                 : String(500) @title: 'PDF URL';
  repoId                 : String(64)  @title: 'DMS Repository ID';
  objectId               : String(128) @title: 'DMS Object ID';
  mimeType               : String(50)  @title: 'MIME Type';
  size                   : Integer     @title: 'File Size (bytes)';
  doxJobId               : String(60)  @title: 'DOX Job ID';
  doxConfidence          : Decimal(5, 2) @title: 'DOX Confidence';

  // --- DOX Extracted Header Fields ---
  paymentTerms           : String(80)  @title: 'Payment Terms';
  receiverName           : String(80)  @title: 'Receiver Name (Buyer)';
  senderName             : String(80)  @title: 'Sender Name (Vendor)';
  senderAddress          : String(100) @title: 'Vendor Address';
  receiverAddress        : String(100) @title: 'Buyer Address';
  documentDate           : Date        @title: 'Invoice Date';
  dueDate                : Date        @title: 'Due Date';
  currencyCode           : String(5)   @title: 'Currency';
  grossAmount            : Decimal(23, 2) @title: 'Gross Amount';
  netAmount              : Decimal(23, 2) @title: 'Net Amount';
  taxAmount              : Decimal(23, 2) @title: 'Tax Amount';
  taxName                : String(50)  @title: 'Tax Description';
  taxRate                : Decimal(5, 2)  @title: 'Tax Rate %';
  
  // --- Address Details ---
  senderCity             : String(40)  @title: 'Vendor City';
  receiverCity           : String(40)  @title: 'Buyer City';
  senderState            : String(3)   @title: 'Vendor State';
  receiverState          : String(3)   @title: 'Buyer State';
  senderPostalCode       : String(10)  @title: 'Vendor Postal Code';
  receiverPostalCode     : String(10)  @title: 'Buyer Postal Code';
  senderExtraAddressPart : String(50)  @title: 'Vendor Addr Extra';
  receiverStreet         : String(60)  @title: 'Buyer Street';
  receiverHouseNumber    : String(10)  @title: 'Buyer House No';
  
  // --- Document References ---
  documentNumber         : String(20)  @title: 'Invoice Number';
  purchaseOrderNumber    : String(35)  @title: 'PO Number';

  // --- S/4HANA Fields ---
  companyCode            : String(4)   @title: 'Company Code';
  supplier               : String(10)  @title: 'Supplier Number';
  supplierName           : String(80)  @title: 'Supplier Name';
  postingDate            : Date        @title: 'Posting Date';
  fiscalYear             : String(4)   @title: 'Fiscal Year';
  accountingDocument     : String(10)  @title: 'Accounting Doc';
  accountingDocType      : String(2)   @title: 'Doc Type'; // RV, KR
  referenceDocument      : String(16)  @title: 'Reference Doc';
  clearingDate           : Date        @title: 'Clearing Date';
  
  // --- SAP Response ---
  sapReturnType          : String(1)   @title: 'SAP Return Type'; // S, E, W, I
  sapReturnMessage       : String(255) @title: 'SAP Message';
  sapMessageClass        : String(20)  @title: 'Message Class';
  sapMessageNumber       : String(3)   @title: 'Message Number';

  // --- Supplier Matching (Vector) ---
  matchedSupplierNumber  : String(10)  @title: 'Matched Supplier';
  matchedSupplierName    : String(120) @title: 'Matched Supplier Name';
  supplierMatchScore     : Decimal(9, 6) @title: 'Match Score';
  supplierMatchStatus    : String(20)  @title: 'Match Status'; // MATCHED, NO_MATCH, MANUAL_REVIEW
  
  // --- PO Matching ---
  poMatchStatus          : String(20)  @title: 'PO Match Status'; // MATCHED, PARTIAL, NO_MATCH
  poMatchConfidence      : Decimal(5, 2) @title: 'PO Match Confidence %';
  
  // --- Approval Workflow ---
  requiresApproval       : Boolean     @title: 'Requires Approval' default false;
  approvalStatus         : String(20)  @title: 'Approval Status'; // PENDING, APPROVED, REJECTED
  approvedBy             : String(100) @title: 'Approved By';
  approvedAt             : Timestamp   @title: 'Approved At';
  rejectionReason        : String(500) @title: 'Rejection Reason';
  
  // --- 3-Way Match Tracking ---
  threeWayMatchRequired  : Boolean     @title: '3-Way Match Required' default false;
  threeWayMatchStatus    : String(20)  @title: '3-Way Match Status'; // PASSED, FAILED, NOT_REQUIRED
  grCheckPassed          : Boolean     @title: 'GR Check Passed';
  
  // --- Error Handling ---
  retryCount             : Integer     @title: 'Retry Count' default 0;
  lastError              : String(500) @title: 'Last Error';
  lastErrorAt            : Timestamp   @title: 'Last Error Time';

  // --- Navigations ---
  doxItems               : Composition of many DOXInvoiceItem
                             on doxItems.invoiceHeader = $self;
  processLogs            : Composition of many InvoiceProcessLog
                             on processLogs.invoiceHeader = $self;
  poItems                : Composition of many SAPPOItem
                             on poItems.invoiceHeader = $self;
}

// ============================================
// DOX LINE ITEMS
// ============================================
entity DOXInvoiceItem : cuid, managed {
  lineNumber             : Integer     @title: 'Line Number';
  description            : String(255) @title: 'Description';
  materialNumber         : String(40)  @title: 'Material Number';
  quantity               : Decimal(13, 3) @title: 'Quantity';
  unitOfMeasure          : String(3)   @title: 'UoM';
  unitPrice              : Decimal(13, 2) @title: 'Unit Price';
  netAmount              : Decimal(23, 2) @title: 'Net Amount';
  taxAmount              : Decimal(23, 2) @title: 'Tax Amount';
  taxCode                : String(2)   @title: 'Tax Code';
  
  // --- Matching ---
  matchStatus            : String(20)  @title: 'Match Status'; // MATCHED, NO_MATCH, PENDING
  matchedPOItem_ID       : UUID        @title: 'Matched PO Item ID';
  matchScore             : Decimal(9, 6) @title: 'Match Score';
  
  invoiceHeader          : Association to InvoiceHeader;
}

// ============================================
// SAP PO ITEMS (Local Cache)
// ============================================
entity SAPPOItem : cuid, managed {
  // --- PO Identity ---
  PurchaseOrder              : String(10)  @title: 'PO Number';
  PurchaseOrderItem          : String(5)   @title: 'PO Item';
  PurchaseOrderItemCategory  : String(1)   @title: 'Item Category';

  // --- Material ---
  Material                   : String(40)  @title: 'Material';
  MaterialName               : String(80)  @title: 'Material Description';
  Plant                      : String(4)   @title: 'Plant';
  StorageLocation            : String(4)   @title: 'Storage Location';

  // --- Quantities ---
  OrderQuantity              : Decimal(13, 3) @title: 'Order Quantity';
  OrderUnit                  : String(3)      @title: 'Order Unit';
  OpenQuantity               : Decimal(13, 3) @title: 'Open Quantity';
  GrQuantityPosted           : Decimal(13, 3) @title: 'GR Quantity';

  // --- Pricing ---
  NetPriceAmount             : Decimal(13, 2) @title: 'Net Price';
  NetPriceQuantity           : Decimal(13, 3) @title: 'Price Quantity';
  NetPriceQuantityUnit       : String(3)      @title: 'Price Unit';
  Currency                   : String(5)      @title: 'Currency';
  TaxCode                    : String(2)      @title: 'Tax Code';

  // --- Dates ---
  DeliveryDate               : Date           @title: 'Delivery Date';

  // --- Indicators ---
  GoodsReceiptIsExpected     : Boolean        @title: 'GR Expected';
  InvoiceIsExpected          : Boolean        @title: 'Invoice Expected';
  InvoiceIsGoodsReceiptBased : Boolean        @title: 'GR-Based IV';

  // --- Account Assignment ---
  AccountAssignmentCategory  : String(1)      @title: 'Acct Assignment';
  GLAccount                  : String(10)     @title: 'G/L Account';
  CostCenter                 : String(10)     @title: 'Cost Center';

  // --- Service PO ---
  ServicePackage             : String(10)     @title: 'Service Package';
  ExpectedOverallLimitAmount : Decimal(15, 2) @title: 'Expected Limit';
  OverallLimitAmount         : Decimal(15, 2) @title: 'Overall Limit';

  // --- GR Tracking ---
  LastGRDocumentYear         : String(4)      @title: 'GR Year';
  LastGRDocument             : String(10)     @title: 'GR Document';
  LastGRDocumentItem         : String(4)      @title: 'GR Item';
  LastGRDate                 : Date           @title: 'GR Date';
  LastGRMessage              : String(255)    @title: 'GR Message';

  // --- Service Entry Sheet ---
  SESLastId                  : String(20)     @title: 'SES Number';
  SESLastItem                : String(10)     @title: 'SES Item';
  SESConfirmedQty            : Decimal(13, 3) @title: 'SES Confirmed Qty';
  SESQuantityUnit            : String(3)      @title: 'SES Unit';
  SESNetAmount               : Decimal(15, 2) @title: 'SES Net Amount';
  SESLastDate                : Date           @title: 'SES Date';
  SESLastMessage             : String(255)    @title: 'SES Message';

  // --- Vector Embedding ---
  embedding                  : Vector = VECTOR_EMBEDDING(
    COALESCE(Material, '') || ' ' || COALESCE(MaterialName, ''),
    'DOCUMENT',
    'SAP_GXY.20250407'
  ) stored;

  invoiceHeader              : Association to InvoiceHeader;
}

// ============================================
// PROCESS LOG
// ============================================
entity InvoiceProcessLog : cuid, managed {
  step          : String(40)  @title: 'Step';
  status        : String(20)  @title: 'Status';
  result        : String(20)  @title: 'Result';
  message       : String(500) @title: 'Message';
  details       : LargeString @title: 'Details (JSON)';
  modifiedDate  : Timestamp   @cds.on.insert: $now;
  modifiedBy    : String(100);
  
  invoiceHeader : Association to InvoiceHeader;
}

// ============================================
// SUPPLIER VECTOR - ENHANCED WITH ADDRESS
// ============================================
entity SupplierVector : managed {
  key supplierNumber : String(10)   @title: 'Supplier Number';
  
  // Name fields
  supplierName       : String(120)  @title: 'Supplier Name';
  altNames           : String(500)  @title: 'Alternative Names';
  
  // Address fields for geographic matching
  street             : String(60)   @title: 'Street';
  city               : String(40)   @title: 'City';
  postalCode         : String(10)   @title: 'Postal Code';
  state              : String(3)    @title: 'State/Region';
  country            : String(3)    @title: 'Country';
  
  isActive           : Boolean      @title: 'Active' default true;
  lastChangedAt      : Timestamp    @title: 'Last Changed';
  
  // Vector embedding (name-based only)
  embedding          : Vector;
  lastRefreshed      : Timestamp    @title: 'Embedding Refreshed';
}

// ============================================
// TYPES
// ============================================
type ValidationResult {
  isValid     : Boolean;
  status      : String(20);
  message     : String(500);
  errors      : array of ValidationError;
}

type ValidationError {
  field       : String(50);
  message     : String(255);
  severity    : String(10); // ERROR, WARNING
}
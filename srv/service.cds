using juno_invoice_assistant_v1 as db from '../db/schema';

@path: '/invoice/v1'
@requires: 'authenticated-user'
service InvoiceServiceV1 {

  // ============================================
  // ENTITIES
  // ============================================
  
  entity InvoiceHeader as projection on db.InvoiceHeader;

  entity DOXInvoiceItem as projection on db.DOXInvoiceItem;

  entity SAPPOItem as projection on db.SAPPOItem excluding { embedding };

  entity InvoiceProcessLog as projection on db.InvoiceProcessLog;

  entity SupplierVector as projection on db.SupplierVector excluding { embedding };

  // ============================================
  // BPA WORKFLOW ACTIONS
  // ============================================

  /**
   * Step 1: Create Invoice Header from DOX extraction
   * BPA calls this after DOX extracts data from PDF
   */
  action CreateInvoiceFromDOX(
    data: LargeString  // JSON string containing DOX extraction result
  ) returns {
    headerId: UUID;
    status: String(20);
    message: String(500);
  };

  /**
   * Step 2: Match Supplier using vector similarity
   * BPA calls this to find supplier number from vendor name
   */
  action MatchSupplier(
    headerId: UUID not null
  ) returns {
    supplierNumber: String(10);
    supplierName: String(120);
    matchScore: Decimal(9, 6);
    confidence: String(20); // HIGH, MEDIUM, LOW, NONE
    status: String(20);
    message: String(500);
  };

  /**
   * Step 3: Match PO Items (if PO exists on invoice)
   * BPA calls this to match DOX line items to PO items
   */
  action MatchPOItems(
    headerId: UUID not null,
    poNumber: String(10),
    fetchFromSAP: Boolean default true
  ) returns {
    totalDoxItems: Integer;
    matchedItems: Integer;
    unmatchedItems: Integer;
    threeWayMatchRequired: Boolean;
    threeWayMatchPassed: Boolean;
    confidence: String(20);
    status: String(20);
    message: String(500);
    matches: array of POItemMatchResult;
  };

  /**
   * Step 4: Validate invoice is ready for posting
   * BPA calls this before sending to approver
   */
  action ValidateForPosting(
    headerId: UUID not null
  ) returns db.ValidationResult;

  /**
   * Step 5: Record approval decision from approver
   * BPA calls after manual approval/rejection
   */
  action RecordApproval(
    headerId: UUID not null,
    approved: Boolean not null,
    approver: String(100) not null,
    comments: String(500)
  ) returns {
    status: String(20);
    message: String(500);
  };

  /**
   * Step 6: Post to SAP S/4HANA
   * BPA calls this to create supplier invoice or accounting document
   */
  action PostToSAP(
    headerId: UUID not null,
    postingType: String(20) default 'SUPPLIER_INVOICE' // 'SUPPLIER_INVOICE' or 'ACCOUNTING_DOC'
  ) returns {
    success: Boolean;
    accountingDocument: String(10);
    fiscalYear: String(4);
    message: String(500);
    sapResponse: LargeString; // Full SAP response as JSON
  };

  /**
   * Step 7: Record SAP posting result
   * BPA calls after receiving SAP response
   */
  action RecordPostingResult(
    data: LargeString // JSON with posting result
  ) returns {
    status: String(20);
    message: String(500);
  };

  // ============================================
  // ADMIN ACTIONS
  // ============================================

  /**
   * Sync suppliers from SAP (one-time setup + delta)
   */
  action SyncSuppliers(
    mode: String default 'delta', // 'full' or 'delta'
    since: Timestamp
  ) returns {
    totalSynced: Integer;
    embeddingsRefreshed: Boolean;
    duration: Integer;
  };

  /**
   * Refresh supplier embeddings
   */
  action RefreshSupplierEmbeddings() returns Integer;

  /**
   * Manually sync PO data from SAP
   */
  action SyncPOFromSAP(
    poNumber: String(10) not null,
    headerId: UUID not null
  ) returns {
    itemsSynced: Integer;
    grDataSynced: Integer;
  };

  /**
   * Get invoice status for BPA polling
   */
  function GetInvoiceStatus(
    headerId: UUID not null
  ) returns {
    headerId: UUID;
    step: String(40);
    status: String(20);
    result: String(20);
    message: String(500);
    supplierMatched: Boolean;
    poMatched: Boolean;
    approved: Boolean;
    posted: Boolean;
  };

  // ============================================
  // INTERNAL ACTIONS (Used by other actions)
  // ============================================

  @cds.internal
  action UpsertPOItems(
    data: LargeString
  ) returns Integer;

  @cds.internal
  action UpsertGRSnapshots(
    data: LargeString
  ) returns Integer;

  @cds.internal
  action UpsertSESSnapshots(
    data: LargeString
  ) returns Integer;

  @cds.internal
  action RefreshPOEmbeddings(
    headerId: UUID
  ) returns Integer;

  // ============================================
  // TYPE DEFINITIONS
  // ============================================

  type POItemMatchResult {
    doxItemId: UUID;
    doxDescription: String(255);
    doxMaterial: String(40);
    doxQuantity: Decimal(13, 3);
    poItemId: UUID;
    poMaterial: String(40);
    poDescription: String(80);
    poQuantity: Decimal(13, 3);
    poOpenQuantity: Decimal(13, 3);
    matchScore: Decimal(9, 6);
    grPosted: Decimal(13, 3);
  };
}
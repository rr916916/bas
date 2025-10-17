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
  // BPA WORKFLOW ACTIONS - OPTIMIZED
  // ============================================

  /**
   * Step 1: Initialize BPA workflow
   * Marks invoice as BPA_STARTED and returns essential header data
   */
  action InitializeBPAWorkflow(
    headerId: UUID not null
  ) returns BPAInvoiceContext;

  /**
   * Step 3: Match Supplier with enhanced context
   * Returns match result with confidence and top candidates
   */
  action MatchSupplier(
    headerId: UUID not null
  ) returns SupplierMatchResult;

  /**
   * Step 6: Validate and update supplier selection
   * Handles all three selection options:
   * 1. Accept suggested match
   * 2. Enter supplier number manually
   * 3. Update name and re-match
   */
  action ProcessSupplierSelection(
    headerId: UUID not null,
    selectionType: String(20) not null,  // 'ACCEPT', 'MANUAL', 'UPDATE_NAME'
    supplierNumber: String(10),          // For ACCEPT or MANUAL
    updatedName: String(80)              // For UPDATE_NAME
  ) returns SupplierSelectionResult;

  /**
   * Step 8: Match PO Items (consolidated)
   */
  action MatchPOItems(
    headerId: UUID not null,
    poNumber: String(10),
    fetchFromSAP: Boolean default true
  ) returns POMatchResult;

  /**
   * Step 9: Validate invoice for posting (consolidated)
   */
  action ValidateInvoice(
    headerId: UUID not null
  ) returns InvoiceValidationResult;

  /**
   * Step 10: Record approval decision
   */
  action RecordApproval(
    headerId: UUID not null,
    approved: Boolean not null,
    approver: String(100) not null,
    comments: String(500)
  ) returns ApprovalResult;

  /**
   * Step 11: Post to SAP
   */
  action PostToSAP(
    headerId: UUID not null,
    postingType: String(20) default 'SUPPLIER_INVOICE'
  ) returns PostingResult;

  /**
   * Step 12: Record posting result
   */
  action RecordPostingResult(
    data: LargeString
  ) returns StatusResult;

  // ============================================
  // UTILITY ACTIONS
  // ============================================

  /**
   * Get current invoice status (for BPA polling)
   */
  function GetInvoiceStatus(
    headerId: UUID not null
  ) returns InvoiceStatusInfo;

  /**
   * Get supplier candidates for selection form
   */
  function GetSupplierCandidates(
    headerId: UUID not null,
    limit: Integer default 5
  ) returns array of SupplierCandidate;

  /**
   * Validate supplier number exists in master data
   */
  function ValidateSupplierNumber(
    supplierNumber: String(10) not null
  ) returns SupplierValidation;

  // ============================================
  // ADMIN ACTIONS
  // ============================================

  action SyncSuppliers(
    mode: String default 'delta',
    since: Timestamp
  ) returns SyncResult;

  action RefreshSupplierEmbeddings() returns Integer;

  action SyncPOFromSAP(
    poNumber: String(10) not null,
    headerId: UUID not null
  ) returns SyncResult;

  // ============================================
  // INTERNAL ACTIONS
  // ============================================

  @cds.internal
  action UpsertPOItems(data: LargeString) returns Integer;

  @cds.internal
  action UpsertGRSnapshots(data: LargeString) returns Integer;

  @cds.internal
  action RefreshPOEmbeddings(headerId: UUID) returns Integer;

  // ============================================
  // TYPE DEFINITIONS
  // ============================================

  /**
   * Essential invoice context for BPA workflow
   */
  type BPAInvoiceContext {
    headerId: UUID;
    step: String(40);
    status: String(20);
    
    // Document info
    fileName: String(255);
    documentNumber: String(20);
    documentDate: Date;
    
    // Amounts
    currencyCode: String(5);
    grossAmount: Decimal(23, 2);
    netAmount: Decimal(23, 2);
    
    // Vendor info from DOX
    senderName: String(80);
    senderAddress: String(100);
    senderCity: String(40);
    senderState: String(3);
    senderPostalCode: String(10);
    
    // PO info
    purchaseOrderNumber: String(35);
    
    // Current matching status
    matchedSupplierNumber: String(10);
    matchedSupplierName: String(120);
    supplierMatchScore: Decimal(9, 6);
    supplierMatchStatus: String(20);
    
    // Counts
    doxItemCount: Integer;
  };

  /**
   * Supplier match result with confidence and alternatives
   */
  type SupplierMatchResult {
    // Primary match
    supplierNumber: String(10);
    supplierName: String(120);
    matchScore: Decimal(9, 6);
    confidence: String(20);        // HIGH, MEDIUM, LOW, NONE
    status: String(20);            // MATCHED, MANUAL_REVIEW, NO_MATCH
    
    // Geographic boost info
    geographicMatch: Boolean;
    boostFactors: String(50);      // e.g., "CITY+STATE"
    
    // Alternative candidates
    alternativeCandidates: array of SupplierCandidate;
    
    // Messages
    message: String(500);
    requiresManualReview: Boolean;
  };

  type SupplierCandidate {
    supplierNumber: String(10);
    supplierName: String(120);
    altNames: String(500);
    city: String(40);
    state: String(3);
    postalCode: String(10);
    matchScore: Decimal(9, 6);
    originalScore: Decimal(9, 6);
    boostFactors: String(50);
  };

  /**
   * Supplier selection processing result
   */
  type SupplierSelectionResult {
    success: Boolean;
    action: String(20);            // ACCEPTED, VALIDATED, UPDATED
    
    // Updated supplier info
    supplierNumber: String(10);
    supplierName: String(120);
    
    // If UPDATE_NAME was used and re-match happened
    rematchPerformed: Boolean;
    newMatchScore: Decimal(9, 6);
    newConfidence: String(20);
    
    // Next step guidance
    requiresReview: Boolean;
    message: String(500);
  };

  /**
   * PO matching result
   */
  type POMatchResult {
    totalDoxItems: Integer;
    matchedItems: Integer;
    unmatchedItems: Integer;
    
    threeWayMatchRequired: Boolean;
    threeWayMatchPassed: Boolean;
    
    confidence: String(20);
    status: String(20);
    message: String(500);
    
    matches: array of POItemMatch;
    unmatchedDoxItems: array of UnmatchedItem;
  };

  type POItemMatch {
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

  type UnmatchedItem {
    itemId: UUID;
    lineNumber: Integer;
    description: String(255);
    material: String(40);
    quantity: Decimal(13, 3);
    amount: Decimal(23, 2);
  };

  /**
   * Comprehensive invoice validation
   */
  type InvoiceValidationResult {
    isValid: Boolean;
    status: String(20);              // VALID, INVALID, VALID_WITH_WARNINGS
    
    // Validation categories
    supplierValidation: ValidationCategory;
    amountValidation: ValidationCategory;
    poValidation: ValidationCategory;
    threeWayMatchValidation: ValidationCategory;
    
    // Summary
    errorCount: Integer;
    warningCount: Integer;
    
    message: String(500);
    allErrors: array of ValidationError;
  };

  type ValidationCategory {
    passed: Boolean;
    errors: array of ValidationError;
    warnings: array of ValidationError;
  };

  type ValidationError {
    field: String(50);
    message: String(255);
    severity: String(10);            // ERROR, WARNING
    code: String(20);
  };

  /**
   * Approval result
   */
  type ApprovalResult {
    status: String(20);              // APPROVED, REJECTED
    message: String(500);
    nextStep: String(40);
  };

  /**
   * Posting result
   */
  type PostingResult {
    success: Boolean;
    accountingDocument: String(10);
    fiscalYear: String(4);
    message: String(500);
    sapResponse: LargeString;
  };

  /**
   * Generic status result
   */
  type StatusResult {
    status: String(20);
    message: String(500);
  };

  /**
   * Invoice status info
   */
  type InvoiceStatusInfo {
    headerId: UUID;
    step: String(40);
    status: String(20);
    result: String(20);
    message: String(500);
    
    supplierMatched: Boolean;
    poMatched: Boolean;
    validated: Boolean;
    approved: Boolean;
    posted: Boolean;
    
    accountingDocument: String(10);
  };

  /**
   * Supplier validation
   */
  type SupplierValidation {
    valid: Boolean;
    supplierExists: Boolean;
    supplierNumber: String(10);
    supplierName: String(120);
    isActive: Boolean;
    message: String(255);
  };

  /**
   * Sync result
   */
  type SyncResult {
    totalSynced: Integer;
    embeddingsRefreshed: Boolean;
    duration: Integer;
    itemsSynced: Integer;
    grDataSynced: Integer;
  };
}
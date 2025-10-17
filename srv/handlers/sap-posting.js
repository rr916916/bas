// srv/handlers/sap-posting.js
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { parseJSON, logProcess } = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('sap-posting');
  const { InvoiceHeader, DOXInvoiceItem, SAPPOItem } = srv.entities;

  // ============================================
  // POST TO SAP
  // ============================================
  srv.on('PostToSAP', async (req) => {
    const { headerId, postingType = 'SUPPLIER_INVOICE' } = req.data;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    // Get invoice with all related data
    const header = await tx.read(InvoiceHeader, headerId, h => {
      h('*'),
      h.doxItems(di => di('*')),
      h.poItems(pi => pi('*'))
    });

    if (!header) {
      req.error(404, `Invoice ${headerId} not found`);
      return;
    }

    LOG.info(`Posting invoice ${headerId} to SAP as ${postingType}`);

    const DEST_NAME = process.env.S4_DEST_NAME || 'S4HANA';
    const SYSTEM_KIND = process.env.S4_KIND || 'cloud';

    try {
      let sapResponse;

      if (postingType === 'SUPPLIER_INVOICE') {
        sapResponse = await postSupplierInvoice(header, DEST_NAME, SYSTEM_KIND);
      } else if (postingType === 'ACCOUNTING_DOC') {
        sapResponse = await postAccountingDocument(header, DEST_NAME, SYSTEM_KIND);
      } else {
        req.error(400, `Invalid posting type: ${postingType}`);
        return;
      }

      const success = sapResponse.type === 'S';

      // Update header
      await tx.update(InvoiceHeader, headerId).set({
        accountingDocument: sapResponse.document,
        fiscalYear: sapResponse.fiscalYear,
        accountingDocType: sapResponse.docType,
        sapReturnType: sapResponse.type,
        sapReturnMessage: sapResponse.message,
        sapMessageClass: sapResponse.messageClass,
        sapMessageNumber: sapResponse.messageNumber,
        step: success ? 'POSTED' : 'POST_FAILED',
        status: success ? 'COMPLETED' : 'ERROR',
        result: success ? 'SUCCESS' : 'FAILURE',
        postingDate: success ? new Date().toISOString().split('T')[0] : null
      });

      await logProcess(tx, headerId, 'SAP_POST', 
        success ? 'POSTED' : 'FAILED',
        success ? 'SUCCESS' : 'FAILURE',
        sapResponse.message,
        { sapResponse: sapResponse.fullResponse }
      );

      LOG.info(`Invoice ${headerId} posting ${success ? 'succeeded' : 'failed'}: ${sapResponse.message}`);

      return {
        success,
        accountingDocument: sapResponse.document,
        fiscalYear: sapResponse.fiscalYear,
        message: sapResponse.message,
        sapResponse: JSON.stringify(sapResponse.fullResponse)
      };

    } catch (error) {
      LOG.error('SAP posting failed:', error);

      await tx.update(InvoiceHeader, headerId).set({
        step: 'POST_ERROR',
        status: 'ERROR',
        result: 'FAILURE',
        lastError: error.message,
        lastErrorAt: new Date(),
        retryCount: { '+=': 1 }
      });

      await logProcess(tx, headerId, 'SAP_POST', 'ERROR', 'FAILURE',
        `Posting error: ${error.message}`);

      req.error(500, `SAP posting failed: ${error.message}`);
    }
  });

  // ============================================
  // RECORD POSTING RESULT
  // ============================================
  srv.on('RecordPostingResult', async (req) => {
    const { data } = req.data;
    const payload = parseJSON(data);

    if (!payload) {
      req.error(400, 'Invalid JSON data');
      return;
    }

    const {
      headerId,
      accountingDocument,
      fiscalYear,
      accountingDocType,
      sapReturnType,
      sapReturnMessage,
      sapMessageClass,
      sapMessageNumber,
      clearingDate
    } = payload;

    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    const isSuccess = sapReturnType === 'S';

    await tx.update(InvoiceHeader, headerId).set({
      accountingDocument,
      fiscalYear,
      accountingDocType,
      sapReturnType,
      sapReturnMessage,
      sapMessageClass,
      sapMessageNumber,
      clearingDate,
      status: isSuccess ? 'COMPLETED' : 'ERROR',
      step: isSuccess ? 'POSTED' : 'POST_FAILED',
      result: isSuccess ? 'SUCCESS' : 'FAILURE'
    });

    await logProcess(tx, headerId, 'SAP_POST',
      isSuccess ? 'POSTED' : 'FAILED',
      isSuccess ? 'SUCCESS' : 'FAILURE',
      sapReturnMessage
    );

    LOG.info(`Posting result recorded for invoice ${headerId}: ${isSuccess ? 'SUCCESS' : 'FAILURE'}`);

    return {
      status: isSuccess ? 'SUCCESS' : 'FAILURE',
      message: sapReturnMessage
    };
  });

  // ============================================
  // HELPER: POST SUPPLIER INVOICE
  // ============================================
  async function postSupplierInvoice(header, destName, systemKind) {
    LOG.info(`Posting supplier invoice to SAP (${systemKind})`);

    const payload = buildSupplierInvoicePayload(header);

    // Log payload for debugging
    LOG.info('Posting payload:', JSON.stringify(payload, null, 2));

    if (systemKind === 'cloud') {
      const path = '/API_SUPPLIERINVOICE_PROCESS_SRV/A_SupplierInvoice';

      try {
        const { data } = await executeHttpRequest(
          { destinationName: destName },
          {
            method: 'POST',
            url: path,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            data: payload
          }
        );

        // Handle different response formats (OData v2 wraps in 'd')
        const result = data?.d || data;

        LOG.info('SAP Response:', JSON.stringify(result, null, 2));

        return {
          type: 'S',
          document: result.SupplierInvoice,
          fiscalYear: result.FiscalYear,
          docType: 'RE',
          message: `Supplier invoice ${result.SupplierInvoice} created successfully`,
          messageClass: '',
          messageNumber: '',
          fullResponse: data
        };

      } catch (error) {
        LOG.error('SAP API Error:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        });

        // Try to extract SAP error details
        const sapError = error.response?.data?.error?.message?.value || 
                        error.response?.data?.error?.message ||
                        error.message;

        throw new Error(`SAP posting failed: ${sapError}`);
      }

    } else {
      // On-prem
      const path = '/sap/opu/odata/sap/API_SUPPLIERINVOICE/SupplierInvoiceSet';

      try {
        const { data } = await executeHttpRequest(
          { destinationName: destName },
          {
            method: 'POST',
            url: path,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            data: payload
          }
        );

        return {
          type: data.ReturnType || 'S',
          document: data.InvoiceDocument,
          fiscalYear: data.FiscalYear,
          docType: 'RE',
          message: data.Message || 'Invoice created',
          messageClass: data.MessageClass,
          messageNumber: data.MessageNumber,
          fullResponse: data
        };

      } catch (error) {
        LOG.error('SAP API Error (on-prem):', error);
        throw new Error(`SAP posting failed: ${error.message}`);
      }
    }
  }

  // ============================================
  // HELPER: POST ACCOUNTING DOCUMENT
  // ============================================
  async function postAccountingDocument(header, destName, systemKind) {
    LOG.info(`Posting accounting document to SAP (${systemKind})`);

    const payload = buildAccountingDocPayload(header);

    if (systemKind === 'cloud') {
      const path = '/API_JOURNALENTRY_SRV/A_JournalEntryBulkCreateRequest';

      const { data } = await executeHttpRequest(
        { destinationName: destName },
        {
          method: 'POST',
          url: path,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          data: payload
        }
      );

      return {
        type: 'S',
        document: data.AccountingDocument,
        fiscalYear: data.FiscalYear,
        docType: 'KR',
        message: `Accounting document ${data.AccountingDocument} created`,
        messageClass: '',
        messageNumber: '',
        fullResponse: data
      };

    } else {
      const path = '/sap/opu/odata/sap/FAC_JOURNALENTRY/JournalEntryCreateRequest';

      const { data } = await executeHttpRequest(
        { destinationName: destName },
        {
          method: 'POST',
          url: path,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          data: payload
        }
      );

      return {
        type: data.ReturnType || 'S',
        document: data.AccountingDocument,
        fiscalYear: data.FiscalYear,
        docType: 'KR',
        message: data.Message || 'Document created',
        messageClass: data.MessageClass,
        messageNumber: data.MessageNumber,
        fullResponse: data
      };
    }
  }

  // ============================================
  // BUILD SUPPLIER INVOICE PAYLOAD (FIXED)
  // ============================================
  function buildSupplierInvoicePayload(header) {
    const items = [];

    // Map DOX items to PO items
    for (const doxItem of header.doxItems || []) {
      if (doxItem.matchStatus !== 'MATCHED' || !doxItem.matchedPOItem_ID) {
        continue;
      }

      const poItem = (header.poItems || []).find(pi => pi.ID === doxItem.matchedPOItem_ID);

      if (!poItem) {
        continue;
      }

      items.push({
        SupplierInvoiceItem: String(items.length + 1).padStart(4, '0'),
        PurchaseOrder: poItem.PurchaseOrder,
        PurchaseOrderItem: poItem.PurchaseOrderItem,
        Plant: poItem.Plant,
        TaxCode: doxItem.taxCode || poItem.TaxCode || '',
        DocumentCurrency: header.currencyCode,
        SupplierInvoiceItemAmount: String(doxItem.netAmount),
        QuantityInPurchaseOrderUnit: String(doxItem.quantity),
        PurchaseOrderQuantityUnit: doxItem.unitOfMeasure || poItem.OrderUnit
      });
    }

    // Convert dates to SAP OData v2 format: /Date(timestamp)/
    const documentDate = formatDateForSAP(header.documentDate);
    const postingDate = formatDateForSAP(new Date());
    const dueDate = formatDateForSAP(header.documentDate);

    // Map payment terms to SAP codes
    const paymentTerms = mapPaymentTerms(header.paymentTerms);

    // ⚠️ KEY FIX: Do NOT send InvoiceDocument and FiscalYear for CREATE
    // SAP generates these values and returns them in the response
    return {
      CompanyCode: header.companyCode,
      DocumentDate: documentDate,
      PostingDate: postingDate,
      InvoicingParty: header.matchedSupplierNumber,
      DocumentCurrency: header.currencyCode,
      InvoiceGrossAmount: String(header.grossAmount),
      DueCalculationBaseDate: dueDate,
      PaymentTerms: paymentTerms,
      DocumentHeaderText: `Invoice ${header.documentNumber || 'AUTO'}`,
      to_SuplrInvcItemPurOrdRef: items
    };
  }

  // ============================================
  // FORMAT DATE FOR SAP ODATA V2
  // ============================================
  function formatDateForSAP(dateValue) {
    if (!dateValue) return null;
    
    let date;
    if (typeof dateValue === 'string') {
      date = new Date(dateValue);
    } else if (dateValue instanceof Date) {
      date = dateValue;
    } else {
      return null;
    }

    // SAP OData v2 expects: /Date(timestamp)/
    const timestamp = date.getTime();
    return `/Date(${timestamp})/`;
  }

  // ============================================
  // MAP PAYMENT TERMS TO SAP CODES
  // ============================================
  function mapPaymentTerms(invoiceTerms) {
    if (!invoiceTerms) return '';

    // Normalize the input
    const normalized = invoiceTerms.trim().toUpperCase();

    // Payment terms mapping - expand this as needed
    const mappings = {
      // Net terms
      'NET 10': '0010',
      'NET 10 EOM': '0010',
      'NET 15': '0015',
      'NET 30': '0030',
      'NET 30 EOM': '0030',
      'NET 45': '0045',
      'NET 60': '0060',
      'NET 90': '0090',
      
      // Due on receipt
      'DUE ON RECEIPT': '0001',
      'IMMEDIATE': '0001',
      'PAYABLE IMMEDIATELY': '0001',
      
      // Common SAP codes (pass through)
      '0001': '0001',
      '0010': '0010',
      '0015': '0015',
      '0030': '0030',
      '0045': '0045',
      '0060': '0060',
      '0090': '0090',
      
      // 2% 10 Net 30 variants
      '2/10 NET 30': 'ZB01',
      '2% 10 NET 30': 'ZB01',
      
      // Default
      'DEFAULT': '0030'
    };

    // Try exact match first
    if (mappings[normalized]) {
      LOG.info(`Mapped payment terms: "${invoiceTerms}" → "${mappings[normalized]}"`);
      return mappings[normalized];
    }

    // Try partial matches
    if (normalized.includes('NET 10') || normalized.includes('N10')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0010"`);
      return '0010';
    }
    if (normalized.includes('NET 15') || normalized.includes('N15')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0015"`);
      return '0015';
    }
    if (normalized.includes('NET 30') || normalized.includes('N30')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0030"`);
      return '0030';
    }
    if (normalized.includes('NET 45') || normalized.includes('N45')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0045"`);
      return '0045';
    }
    if (normalized.includes('NET 60') || normalized.includes('N60')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0060"`);
      return '0060';
    }
    if (normalized.includes('NET 90') || normalized.includes('N90')) {
      LOG.info(`Mapped payment terms (partial): "${invoiceTerms}" → "0090"`);
      return '0090';
    }

    // No match found - return empty string (SAP will use supplier default)
    LOG.warn(`Payment terms not mapped: "${invoiceTerms}" - using empty string`);
    return '';
  }

  // ============================================
  // BUILD ACCOUNTING DOCUMENT PAYLOAD
  // ============================================
  function buildAccountingDocPayload(header) {
    const items = [];

    // Vendor item (credit)
    items.push({
      GLAccount: '',
      AccountingDocumentItem: '001',
      AccountingDocumentItemType: 'K',
      Supplier: header.matchedSupplierNumber,
      AmountInTransactionCurrency: header.grossAmount,
      DebitCreditCode: 'H',
      DocumentItemText: `Invoice ${header.documentNumber || 'AUTO'}`
    });

    // Line items (debit)
    let itemNum = 2;
    for (const doxItem of header.doxItems || []) {
      items.push({
        GLAccount: '400000',
        AccountingDocumentItem: String(itemNum).padStart(3, '0'),
        AmountInTransactionCurrency: doxItem.netAmount,
        DebitCreditCode: 'S',
        TaxCode: doxItem.taxCode,
        DocumentItemText: doxItem.description || 'Invoice Item'
      });
      itemNum++;
    }

    // Tax item
    if (header.taxAmount && header.taxAmount > 0) {
      items.push({
        GLAccount: '154000',
        AccountingDocumentItem: String(itemNum).padStart(3, '0'),
        AmountInTransactionCurrency: header.taxAmount,
        DebitCreditCode: 'S',
        TaxCode: header.doxItems?.[0]?.taxCode,
        DocumentItemText: 'Tax'
      });
    }

    return {
      MessageHeader: {
        CreationDateTime: new Date().toISOString()
      },
      JournalEntry: {
        CompanyCode: header.companyCode,
        DocumentDate: header.documentDate,
        PostingDate: new Date().toISOString().split('T')[0],
        DocumentHeaderText: `Invoice ${header.documentNumber || 'AUTO'}`,
        DocumentReferenceID: header.documentNumber,
        Items: items
      }
    };
  }
};
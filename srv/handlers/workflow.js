// srv/handlers/workflow.js
// Handles BPA workflow-specific actions
const cds = require('@sap/cds');
const { logProcess } = require('../utils/helpers');

module.exports = function(srv) {
  const LOG = cds.log('workflow');
  const { InvoiceHeader, DOXInvoiceItem } = srv.entities;

  // ============================================
  // STEP 1: INITIALIZE BPA WORKFLOW
  // ============================================
  srv.on('InitializeBPAWorkflow', async (req) => {
    // BPA sends as flat key-value pairs in req.data
    const headerId = req.data.headerId;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    try {
      // Get header with DOX items count
      const header = await tx.read(InvoiceHeader, headerId, h => {
        h('*'),
        h.doxItems(di => di('ID'))
      });

      if (!header) {
        req.error(404, `Invoice ${headerId} not found`);
        return;
      }

      // Update status to BPA_STARTED
      await tx.update(InvoiceHeader, headerId).set({
        step: 'BPA_STARTED',
        status: 'IN_PROGRESS',
        message: 'BPA workflow initiated'
      });

      await logProcess(tx, headerId, 'BPA_INIT', 'STARTED', 'SUCCESS',
        'BPA workflow initialized');

      LOG.info(`BPA workflow initialized for invoice ${headerId}`);

      // Return essential context for BPA
      return {
        headerId: header.ID,
        step: 'BPA_STARTED',
        status: 'IN_PROGRESS',
        
        // Document info
        fileName: header.fileName,
        documentNumber: header.documentNumber,
        documentDate: header.documentDate,
        
        // Amounts
        currencyCode: header.currencyCode,
        grossAmount: header.grossAmount,
        netAmount: header.netAmount,
        
        // Vendor info from DOX
        senderName: header.senderName,
        senderAddress: header.senderAddress,
        senderCity: header.senderCity,
        senderState: header.senderState,
        senderPostalCode: header.senderPostalCode,
        
        // PO info
        purchaseOrderNumber: header.purchaseOrderNumber,
        
        // Current matching status
        matchedSupplierNumber: header.matchedSupplierNumber,
        matchedSupplierName: header.matchedSupplierName,
        supplierMatchScore: header.supplierMatchScore,
        supplierMatchStatus: header.supplierMatchStatus,
        
        // Counts
        doxItemCount: header.doxItems?.length || 0
      };

    } catch (error) {
      LOG.error('BPA initialization failed:', error);
      req.error(500, `BPA initialization failed: ${error.message}`);
    }
  });

  // ============================================
  // STEP 6: PROCESS SUPPLIER SELECTION
  // ============================================
  srv.on('ProcessSupplierSelection', async (req) => {
    // BPA sends as flat key-value pairs
    const headerId = req.data.headerId;
    const selectionType = req.data.selectionType;
    const supplierNumber = req.data.supplierNumber;
    const updatedName = req.data.updatedName;

    if (!headerId || !selectionType) {
      req.error(400, 'headerId and selectionType are required');
      return;
    }

    const tx = cds.tx(req);

    try {
      const header = await tx.read(InvoiceHeader, headerId, [
        'ID', 'senderName', 'matchedSupplierNumber', 'matchedSupplierName',
        'supplierMatchScore'
      ]);

      if (!header) {
        req.error(404, `Invoice ${headerId} not found`);
        return;
      }

      LOG.info(`Processing supplier selection for ${headerId}: ${selectionType}`);

      let result = {
        success: false,
        action: '',
        supplierNumber: null,
        supplierName: null,
        rematchPerformed: false,
        newMatchScore: null,
        newConfidence: null,
        requiresReview: false,
        message: ''
      };

      // ============================================
      // OPTION 1: ACCEPT SUGGESTED MATCH
      // ============================================
      if (selectionType === 'ACCEPT') {
        if (!header.matchedSupplierNumber) {
          req.error(400, 'No supplier match to accept');
          return;
        }

        // Validate the supplier exists
        const validation = await srv.send({
          event: 'ValidateSupplierNumber',
          data: { supplierNumber: header.matchedSupplierNumber }
        });

        if (!validation.valid) {
          req.error(400, `Supplier ${header.matchedSupplierNumber} is invalid: ${validation.message}`);
          return;
        }

        await tx.update(InvoiceHeader, headerId).set({
          supplier: header.matchedSupplierNumber,
          supplierName: header.matchedSupplierName,
          supplierMatchStatus: 'ACCEPTED',
          step: 'SUPPLIER_ACCEPTED',
          message: `Supplier ${header.matchedSupplierName} accepted by user`
        });

        await logProcess(tx, headerId, 'SUPPLIER_SELECT', 'ACCEPTED', 'SUCCESS',
          `User accepted suggested supplier: ${header.matchedSupplierName}`);

        result = {
          success: true,
          action: 'ACCEPTED',
          supplierNumber: header.matchedSupplierNumber,
          supplierName: header.matchedSupplierName,
          rematchPerformed: false,
          requiresReview: false,
          message: `Supplier ${header.matchedSupplierName} accepted successfully`
        };

        LOG.info(`Supplier match accepted for invoice ${headerId}: ${header.matchedSupplierNumber}`);
      }

      // ============================================
      // OPTION 2: MANUAL SUPPLIER NUMBER ENTRY
      // ============================================
      else if (selectionType === 'MANUAL') {
        if (!supplierNumber) {
          req.error(400, 'supplierNumber is required for MANUAL selection');
          return;
        }

        // Validate the supplier
        const validation = await srv.send({
          event: 'ValidateSupplierNumber',
          data: { supplierNumber: supplierNumber.padStart(10, '0') }
        });

        if (!validation.valid) {
          req.error(400, `Supplier ${supplierNumber} is invalid: ${validation.message}`);
          return;
        }

        const paddedNumber = supplierNumber.padStart(10, '0');

        await tx.update(InvoiceHeader, headerId).set({
          matchedSupplierNumber: paddedNumber,
          matchedSupplierName: validation.supplierName,
          supplier: paddedNumber,
          supplierName: validation.supplierName,
          supplierMatchScore: 1.0,
          supplierMatchStatus: 'MANUAL',
          step: 'SUPPLIER_MANUAL',
          message: `Supplier manually entered: ${validation.supplierName}`
        });

        await logProcess(tx, headerId, 'SUPPLIER_SELECT', 'MANUAL', 'SUCCESS',
          `User manually entered supplier: ${paddedNumber} - ${validation.supplierName}`);

        result = {
          success: true,
          action: 'VALIDATED',
          supplierNumber: paddedNumber,
          supplierName: validation.supplierName,
          rematchPerformed: false,
          requiresReview: false,
          message: `Supplier ${validation.supplierName} validated and assigned`
        };

        LOG.info(`Manual supplier entry for invoice ${headerId}: ${paddedNumber}`);
      }

      // ============================================
      // OPTION 3: UPDATE NAME AND RE-MATCH
      // ============================================
      else if (selectionType === 'UPDATE_NAME') {
        if (!updatedName) {
          req.error(400, 'updatedName is required for UPDATE_NAME selection');
          return;
        }

        // Update the sender name
        await tx.update(InvoiceHeader, headerId).set({
          senderName: updatedName,
          step: 'SUPPLIER_NAME_UPDATED',
          message: `Supplier name updated to: ${updatedName}`
        });

        await logProcess(tx, headerId, 'SUPPLIER_UPDATE', 'NAME_CHANGED', 'SUCCESS',
          `User updated supplier name from "${header.senderName}" to "${updatedName}"`);

        // Re-run supplier matching with updated name
        const matchResult = await srv.send({
          event: 'MatchSupplier',
          data: { headerId }
        });

        result = {
          success: true,
          action: 'UPDATED',
          supplierNumber: matchResult.supplierNumber,
          supplierName: matchResult.supplierName,
          rematchPerformed: true,
          newMatchScore: matchResult.matchScore,
          newConfidence: matchResult.confidence,
          requiresReview: matchResult.confidence === 'LOW' || matchResult.confidence === 'NONE',
          message: `Name updated to "${updatedName}". New match: ${matchResult.supplierName || 'No match'} (${matchResult.confidence})`
        };

        LOG.info(`Supplier name updated and re-matched for invoice ${headerId}: ${matchResult.confidence}`);
      }

      else {
        req.error(400, `Invalid selectionType: ${selectionType}. Must be ACCEPT, MANUAL, or UPDATE_NAME`);
        return;
      }

      return result;

    } catch (error) {
      LOG.error('Supplier selection processing failed:', error);
      req.error(500, `Supplier selection failed: ${error.message}`);
    }
  });

  // ============================================
  // VALIDATE INVOICE (CONSOLIDATED)
  // ============================================
  srv.on('ValidateInvoice', async (req) => {
    // BPA sends as flat key-value pairs
    const headerId = req.data.headerId;
    
    if (!headerId) {
      req.error(400, 'headerId is required');
      return;
    }

    const tx = cds.tx(req);

    try {
      const header = await tx.read(InvoiceHeader, headerId, h => {
        h('*'),
        h.doxItems('*'),
        h.poItems('*')
      });

      if (!header) {
        req.error(404, `Invoice ${headerId} not found`);
        return;
      }

      LOG.info(`Validating invoice ${headerId}`);

      // Initialize validation structure
      const validation = {
        isValid: true,
        status: 'VALID',
        supplierValidation: { passed: true, errors: [], warnings: [] },
        amountValidation: { passed: true, errors: [], warnings: [] },
        poValidation: { passed: true, errors: [], warnings: [] },
        threeWayMatchValidation: { passed: true, errors: [], warnings: [] },
        errorCount: 0,
        warningCount: 0,
        message: '',
        allErrors: []
      };

      // ============================================
      // SUPPLIER VALIDATION
      // ============================================
      if (!header.matchedSupplierNumber) {
        addError(validation.supplierValidation, 'supplier', 
          'Supplier not matched', 'ERROR', 'SUP_001');
      } else if (header.supplierMatchScore < 0.7) {
        addError(validation.supplierValidation, 'supplier',
          `Supplier match confidence low: ${(header.supplierMatchScore * 100).toFixed(1)}%`,
          'WARNING', 'SUP_002');
      }

      // ============================================
      // AMOUNT VALIDATION
      // ============================================
      if (!header.netAmount || header.netAmount <= 0) {
        addError(validation.amountValidation, 'netAmount',
          'Net amount is missing or invalid', 'ERROR', 'AMT_001');
      }

      if (!header.grossAmount || header.grossAmount <= 0) {
        addError(validation.amountValidation, 'grossAmount',
          'Gross amount is missing or invalid', 'ERROR', 'AMT_002');
      }

      if (!header.currencyCode) {
        addError(validation.amountValidation, 'currency',
          'Currency code is required', 'ERROR', 'AMT_003');
      }

      if (!header.documentDate) {
        addError(validation.amountValidation, 'documentDate',
          'Document date is required', 'ERROR', 'AMT_004');
      }

      if (!header.companyCode) {
        addError(validation.amountValidation, 'companyCode',
          'Company code is required', 'ERROR', 'AMT_005');
      }

      // ============================================
      // PO VALIDATION (if applicable)
      // ============================================
      if (header.purchaseOrderNumber) {
        const doxItems = header.doxItems || [];
        const matchedCount = doxItems.filter(i => i.matchStatus === 'MATCHED').length;

        if (matchedCount === 0 && doxItems.length > 0) {
          addError(validation.poValidation, 'poItems',
            'No DOX items matched to PO items', 'ERROR', 'PO_001');
        } else if (matchedCount < doxItems.length) {
          addError(validation.poValidation, 'poItems',
            `Only ${matchedCount} of ${doxItems.length} items matched`,
            'WARNING', 'PO_002');
        }

        // 3-way match validation
        if (header.threeWayMatchRequired) {
          if (!header.grCheckPassed) {
            addError(validation.threeWayMatchValidation, 'goodsReceipt',
              '3-way match failed: Goods receipt not posted for all items',
              'ERROR', 'GR_001');
          }

          if (header.threeWayMatchStatus === 'FAILED') {
            addError(validation.threeWayMatchValidation, 'threeWayMatch',
              '3-way match validation failed',
              'ERROR', 'GR_002');
          }
        }
      }

      // ============================================
      // AGGREGATE RESULTS
      // ============================================
      validation.errorCount = [
        ...validation.supplierValidation.errors,
        ...validation.amountValidation.errors,
        ...validation.poValidation.errors,
        ...validation.threeWayMatchValidation.errors
      ].filter(e => e.severity === 'ERROR').length;

      validation.warningCount = [
        ...validation.supplierValidation.errors,
        ...validation.amountValidation.errors,
        ...validation.poValidation.errors,
        ...validation.threeWayMatchValidation.errors
      ].filter(e => e.severity === 'WARNING').length;

      validation.allErrors = [
        ...validation.supplierValidation.errors,
        ...validation.amountValidation.errors,
        ...validation.poValidation.errors,
        ...validation.threeWayMatchValidation.errors
      ];

      validation.supplierValidation.passed = validation.supplierValidation.errors
        .filter(e => e.severity === 'ERROR').length === 0;
      
      validation.amountValidation.passed = validation.amountValidation.errors
        .filter(e => e.severity === 'ERROR').length === 0;
      
      validation.poValidation.passed = validation.poValidation.errors
        .filter(e => e.severity === 'ERROR').length === 0;
      
      validation.threeWayMatchValidation.passed = validation.threeWayMatchValidation.errors
        .filter(e => e.severity === 'ERROR').length === 0;

      validation.isValid = validation.errorCount === 0;

      if (validation.errorCount > 0) {
        validation.status = 'INVALID';
        validation.message = `Validation failed with ${validation.errorCount} error(s)`;
      } else if (validation.warningCount > 0) {
        validation.status = 'VALID_WITH_WARNINGS';
        validation.message = `Validation passed with ${validation.warningCount} warning(s)`;
      } else {
        validation.status = 'VALID';
        validation.message = 'All validations passed successfully';
      }

      // Update header status
      await tx.update(InvoiceHeader, headerId).set({
        step: validation.isValid ? 'VALIDATED' : 'VALIDATION_FAILED',
        status: validation.isValid ? 'IN_PROGRESS' : 'ERROR',
        message: validation.message
      });

      await logProcess(tx, headerId, 'VALIDATE', 
        validation.isValid ? 'PASSED' : 'FAILED',
        validation.isValid ? 'SUCCESS' : 'FAILURE',
        validation.message,
        { 
          errorCount: validation.errorCount,
          warningCount: validation.warningCount,
          errors: validation.allErrors 
        }
      );

      LOG.info(`Validation for invoice ${headerId}: ${validation.status}`, {
        errors: validation.errorCount,
        warnings: validation.warningCount
      });

      return validation;

    } catch (error) {
      LOG.error('Invoice validation failed:', error);
      req.error(500, `Validation failed: ${error.message}`);
    }
  });

  // ============================================
  // HELPER: ADD VALIDATION ERROR
  // ============================================
  function addError(category, field, message, severity, code) {
    const error = { field, message, severity, code };
    category.errors.push(error);
    
    if (severity === 'WARNING') {
      category.warnings.push(error);
    }
  }
};
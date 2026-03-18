const PDFDocument = require('pdfkit');
const moment = require('moment');
const { Order } = require('../models');

// ============================================
// GENERATE BILL (text data)
// ============================================
exports.generateBill = async (order, restaurant) => {
  const billNumber = `BILL-${order.orderNumber}`;

  // Mark bill as generated
  await Order.findByIdAndUpdate(order._id, {
    'bill.generated': true,
    'bill.generatedAt': new Date(),
    'bill.billNumber': billNumber,
  });

  const bill = {
    billNumber,
    restaurantName: restaurant.name,
    restaurantAddress: restaurant.address
      ? `${restaurant.address.street || ''}, ${restaurant.address.city || ''}`
      : '',
    restaurantPhone: restaurant.contact?.phone || '',
    restaurantGST: restaurant.gstNumber || '',
    orderNumber: order.orderNumber,
    tableNumber: order.tableNumber,
    customerName: order.customerName || 'Guest',
    guestCount: order.guestCount,
    date: moment(order.createdAt).format('DD/MM/YYYY HH:mm'),
    items: order.items.map(item => ({
      name: item.productName,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
      variants: item.selectedVariants?.map(v => `${v.name}: ${v.selected}`).join(', '),
      addOns: item.selectedAddOns?.map(a => a.selected.join(', ')).join(' | '),
    })),
    pricing: order.pricing,
    payment: order.payment,
    currency: restaurant.settings?.currencySymbol || '₹',
    generatedAt: new Date().toISOString(),
  };

  return bill;
};

// exports.generateBill = async (order, restaurant) => {
//   const billNumber = `BILL-${order.orderNumber}`;

//   await Order.findByIdAndUpdate(order._id, {
//     'bill.generated': true,
//     'bill.generatedAt': new Date(),
//     'bill.billNumber': billNumber,
//   });

//   const p = order.pricing || {}
//   // Fix grandTotal — use total as fallback if grandTotal is 0
//   const grandTotal = p.grandTotal || p.total || (p.subtotal + p.tax + (p.serviceCharge||0) + (p.tip||0) - (p.discount||0))

//   const bill = {
//     billNumber,
//     restaurantName: restaurant.name,
//     restaurantAddress: restaurant.address
//       ? `${restaurant.address.street || ''}, ${restaurant.address.city || ''}`
//       : '',
//     restaurantPhone: restaurant.contact?.phone || '',
//     restaurantGST: restaurant.gstin || restaurant.gstNumber || '',
//     orderNumber: order.orderNumber,
//     tableNumber: order.tableNumber,
//     customerName: order.customerName || 'Guest',
//     guestCount: order.guestCount,
//     date: moment(order.createdAt).format('DD/MM/YYYY HH:mm'),
//     items: order.items.map(item => ({
//       productName: item.productName,  // ✅ Fix: was 'name', frontend expects 'productName'
//       name: item.productName,         // keep both for PDF compatibility
//       quantity: item.quantity,
//       unitPrice: item.unitPrice,
//       total: item.total,
//       selectedVariants: item.selectedVariants,  // ✅ Fix: pass full object, not pre-joined string
//       variants: item.selectedVariants?.map(v => `${v.name}: ${v.selected}`).join(', '),
//       addOns: item.selectedAddOns?.map(a => a.selected.join(', ')).join(' | '),
//     })),
//     pricing: {
//       ...p,
//       grandTotal,  // ✅ Fix: computed grandTotal
//     },
//     payment: order.payment,
//     currency: restaurant.settings?.currencySymbol || '₹',
//     generatedAt: new Date().toISOString(),
//   };

//   return bill;
// };

// ============================================
// GENERATE BILL PDF (Buffer)
// ============================================
exports.generateBillPDF = (bill) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [226.77, 800], margin: 10 }); // 80mm receipt
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const W = 226.77 - 20; // usable width
    const curr = bill.currency;

    // Header
    doc.fontSize(12).font('Helvetica-Bold').text(bill.restaurantName, { align: 'center' });
    if (bill.restaurantAddress) {
      doc.fontSize(7).font('Helvetica').text(bill.restaurantAddress, { align: 'center' });
    }
    if (bill.restaurantPhone) {
      doc.fontSize(7).text(`Tel: ${bill.restaurantPhone}`, { align: 'center' });
    }
    doc.moveDown(0.3);
    doc.fontSize(8).font('Helvetica-Bold').text('TAX INVOICE', { align: 'center' });
    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();
    doc.moveDown(0.3);

    // Order info
    doc.fontSize(7).font('Helvetica');
    doc.text(`Bill No : ${bill.billNumber}`, 10);
    doc.text(`Date    : ${bill.date}`, 10);
    doc.text(`Table   : ${bill.tableNumber}`, 10);
    if (bill.customerName !== 'Guest') doc.text(`Customer: ${bill.customerName}`, 10);
    doc.text(`Guests  : ${bill.guestCount}`, 10);
    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();
    doc.moveDown(0.3);

    // Column headers
    doc.font('Helvetica-Bold').fontSize(7);
    doc.text('Item', 10, doc.y, { width: 100 });
    doc.text('Qty', 110, doc.y - doc.currentLineHeight(), { width: 25, align: 'center' });
    doc.text('Price', 135, doc.y - doc.currentLineHeight(), { width: 40, align: 'right' });
    doc.text('Total', 175, doc.y - doc.currentLineHeight(), { width: 40, align: 'right' });
    doc.moveDown(0.2);
    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();

    // Items
    doc.font('Helvetica').fontSize(7);
    bill.items.forEach(item => {
      const y = doc.y;
      doc.text(item.name, 10, y, { width: 100 });
      doc.text(String(item.quantity), 110, y, { width: 25, align: 'center' });
      doc.text(`${curr}${item.unitPrice.toFixed(2)}`, 135, y, { width: 40, align: 'right' });
      doc.text(`${curr}${item.total.toFixed(2)}`, 175, y, { width: 40, align: 'right' });
      if (item.variants) {
        doc.fontSize(6).fillColor('gray').text(`  ${item.variants}`, 10, doc.y, { width: 200 });
        doc.fillColor('black').fontSize(7);
      }
    });

    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();

    // Totals
    const addRow = (label, value, bold = false) => {
      const y = doc.y + 2;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
      doc.text(label, 10, y, { width: 140 });
      doc.text(`${curr}${value.toFixed(2)}`, 150, y, { width: 65, align: 'right' });
    };

    const p = bill.pricing;
    addRow('Subtotal', p.subtotal);
    if (p.discount > 0) addRow(`Discount`, -p.discount);
    addRow(`Tax (${p.taxRate}%)`, p.tax);
    if (p.serviceCharge > 0) addRow('Service Charge', p.serviceCharge);
    if (p.tip > 0) addRow('Tip', p.tip);
    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();
    addRow('TOTAL', p.grandTotal, true);
    doc.moveTo(10, doc.y).lineTo(W + 10, doc.y).stroke();

    // Payment
    if (bill.payment?.method) {
      doc.moveDown(0.3).font('Helvetica').fontSize(7);
      doc.text(`Payment: ${bill.payment.method?.toUpperCase()}`, 10);
      if (bill.payment.transactionId) doc.text(`Txn ID: ${bill.payment.transactionId}`, 10);
    }

    // Footer
    doc.moveDown(0.5);
    doc.fontSize(8).font('Helvetica-Bold').text('Thank you for dining with us!', { align: 'center' });
    doc.fontSize(7).font('Helvetica').text('Please visit again', { align: 'center' });

    doc.end();
  });
};

// ============================================
// GENERATE SALES REPORT PDF
// ============================================
exports.generateReportPDF = (report, restaurant) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const buffers = [];

    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    const W = 595.28 - 80;

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(restaurant.name, { align: 'center' });
    doc.fontSize(12).font('Helvetica').text('SALES REPORT', { align: 'center' });
    doc.fontSize(10).text(`Period: ${report.period.from} to ${report.period.to}`, { align: 'center' });
    doc.moveDown();
    doc.moveTo(40, doc.y).lineTo(W + 40, doc.y).lineWidth(2).stroke();
    doc.moveDown();

    // Summary box
    doc.fontSize(14).font('Helvetica-Bold').text('Summary');
    doc.moveDown(0.3);
    const s = report.summary;
    const rows = [
      ['Total Orders', s.totalOrders],
      ['Completed Orders', s.completedOrders],
      ['Cancelled Orders', `${s.cancelledOrders} (${s.cancellationRate}%)`],
      ['Gross Revenue', `₹${s.grossRevenue.toFixed(2)}`],
      ['Total Tax (GST)', `₹${s.totalTax.toFixed(2)}`],
      ['Total Discounts', `₹${s.totalDiscounts.toFixed(2)}`],
      ['Total Tips', `₹${s.totalTips.toFixed(2)}`],
      ['Cash Revenue', `₹${s.cashRevenue.toFixed(2)}`],
      ['Online Revenue', `₹${s.onlineRevenue.toFixed(2)}`],
      ['Avg Order Value', `₹${s.avgOrderValue}`],
    ];

    rows.forEach(([label, value]) => {
      doc.fontSize(10).font('Helvetica');
      const y = doc.y;
      doc.text(label, 40, y, { width: 200 });
      doc.font('Helvetica-Bold').text(String(value), 240, y);
      doc.moveDown(0.2);
    });

    doc.moveDown();
    doc.moveTo(40, doc.y).lineTo(W + 40, doc.y).stroke();

    // Top Items
    doc.moveDown();
    doc.fontSize(14).font('Helvetica-Bold').text('Top Selling Items');
    doc.moveDown(0.3);

    if (report.topItems?.length > 0) {
      doc.fontSize(9).font('Helvetica-Bold');
      doc.text('Item', 40, doc.y, { width: 200 });
      doc.text('Qty', 240, doc.y - doc.currentLineHeight(), { width: 60, align: 'right' });
      doc.text('Revenue', 300, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
      doc.moveDown(0.2);
      doc.moveTo(40, doc.y).lineTo(W + 40, doc.y).stroke();

      report.topItems.forEach(item => {
        doc.fontSize(9).font('Helvetica');
        const y = doc.y + 2;
        doc.text(item.name, 40, y, { width: 200 });
        doc.text(String(item.qty), 240, y, { width: 60, align: 'right' });
        doc.text(`₹${item.revenue.toFixed(2)}`, 300, y, { width: 80, align: 'right' });
        doc.moveDown(0.1);
      });
    }

    // Footer
    doc.moveDown(2);
    doc.fontSize(8).font('Helvetica').fillColor('gray');
    doc.text(`Generated on ${report.generatedAt}`, { align: 'center' });
    doc.text('Powered by Restaurant SaaS', { align: 'center' });

    doc.end();
  });
};

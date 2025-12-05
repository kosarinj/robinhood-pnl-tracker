# Robinhood P&L Tracker

A React-based web application that analyzes your Robinhood trading data and calculates profit/loss using both FIFO (First In, First Out) and LIFO (Last In, First Out) accounting methods.

## Features

- Upload Robinhood CSV export files
- Real-time market prices from Yahoo Finance
- Calculate realized and unrealized P&L
- Side-by-side FIFO and LIFO comparisons
- Filter to include/exclude options trades
- Clean, responsive interface with summary cards

## Getting Started

### Installation

1. Navigate to the project directory:
```bash
cd robinhood-pnl-tracker
```

2. Install dependencies (already done):
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

4. Open your browser to `http://localhost:3000`

### Exporting Data from Robinhood

1. Log in to your Robinhood account on the web
2. Go to Account → Statements & History
3. Download your account statements or trade history as CSV
4. Upload the CSV file to this application

### Expected CSV Format

The app expects a CSV file with the following columns (standard Robinhood export format):

- **Activity Date** or **Date**: Date of the trade
- **Instrument** or **Symbol**: Stock symbol or option description
- **Description**: Trade description
- **Trans Code** or **Type**: BUY or SELL
- **Quantity** or **Qty**: Number of shares
- **Price** or **Trade Price**: Price per share
- **Amount**: Total transaction amount

Sample CSV format:
```csv
Activity Date,Instrument,Description,Trans Code,Quantity,Price,Amount
2024-01-15,AAPL,Apple Inc.,BUY,10,150.00,1500.00
2024-02-20,AAPL,Apple Inc.,SELL,5,160.00,800.00
```

### Understanding FIFO vs LIFO

- **FIFO (First In, First Out)**: When calculating realized gains, shares purchased earliest are sold first
- **LIFO (Last In, First Out)**: When calculating realized gains, shares purchased most recently are sold first

Different accounting methods can result in different tax liabilities, which is why both are displayed.

## How It Works

1. **Upload CSV**: Select your Robinhood trade history CSV file
2. **Parse Trades**: The app extracts all buy/sell transactions
3. **Fetch Prices**: Current market prices are fetched from Yahoo Finance
4. **Calculate P&L**:
   - Realized P&L: Profit/loss from closed positions
   - Unrealized P&L: Profit/loss from open positions at current market price
   - Total P&L: Sum of realized and unrealized
5. **Display Results**: View comprehensive breakdown by symbol with both FIFO and LIFO methods

## Technology Stack

- **React**: UI framework
- **Vite**: Build tool and dev server
- **PapaParse**: CSV parsing library
- **Axios**: HTTP client for API calls
- **Yahoo Finance API**: Real-time market data

## Features Detail

### Summary Cards
At the top of the results, you'll see summary cards showing:
- Total P&L (FIFO and LIFO)
- Total Realized P&L (FIFO and LIFO)
- Total Unrealized P&L (FIFO and LIFO)

### Data Grid
The table displays:
- **Instrument**: Stock symbol with option indicator
- **Current Price**: Latest market price from Yahoo Finance
- **Position**: Current number of shares held
- **FIFO Columns**: Average cost basis, realized P&L, unrealized P&L, total P&L
- **LIFO Columns**: Average cost basis, realized P&L, unrealized P&L, total P&L

### Options Filter
Use the "Include Options" checkbox to toggle visibility of options trades in the grid.

## Building for Production

To create a production build:
```bash
npm run build
```

The built files will be in the `dist` directory and can be deployed to any static hosting service.

## Notes

- This app runs entirely in your browser - no data is sent to any server except Yahoo Finance for price quotes
- Make sure your CSV file follows the Robinhood export format
- Options are identified by spaces in the instrument name or "option" in the description
- The underlying stock symbol is extracted from option instruments

## Troubleshooting

**"No valid trades found in CSV"**
- Ensure your CSV has the correct column headers
- Check that quantity and price values are valid numbers

**"Could not fetch price for [symbol]"**
- The symbol might be delisted or Yahoo Finance might not have data
- Check your internet connection
- The app will continue with a price of $0 for that symbol

**CORS errors when fetching prices**
- Yahoo Finance API is public and should work from browsers
- If you encounter CORS issues, you may need to set up a simple proxy server

## Future Enhancements

Potential features for backend integration:
- Save and load trade history
- Historical P&L tracking over time
- Tax reporting features
- Multiple portfolio support
- Email notifications for P&L changes

## License

This is a personal finance tool. Use at your own discretion. Always consult with a tax professional for official tax reporting.

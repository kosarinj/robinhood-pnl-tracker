// S&P 500 representative ticker list (~200 most liquid components)
export const SP500_TICKERS = [
  // Mega-cap tech
  'AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AVGO','ORCL','CRM',
  'AMD','QCOM','INTC','TXN','ADI','AMAT','LRCX','KLAC','MCHP','MU',
  'SNPS','CDNS','NOW','INTU','ADBE','PANW','CRWD','FTNT','ZS','WDAY',
  'DDOG','TEAM','ANSS','MPWR','VEEV','NET','MDB','OKTA','HUBS','TTD',
  // Financials
  'JPM','BAC','WFC','GS','MS','C','BLK','SCHW','AXP','COF',
  'MCO','SPGI','ICE','CME','NDAQ','MSCI','BX','KKR','APO','ARES',
  'PGR','TRV','ALL','CB','AON','MMC','AIG','PRU','MET','AFL',
  // Healthcare
  'UNH','LLY','JNJ','ABBV','MRK','PFE','TMO','ABT','DHR','BSX',
  'ISRG','MDT','SYK','EW','ZTS','VRTX','REGN','AMGN','GILD','BMY',
  'ELV','CI','HUM','CVS','HCA','MCK','ABC','DXCM','IDXX','BDX',
  // Consumer Discretionary
  'HD','LOW','MCD','SBUX','NKE','TGT','COST','CMG','BKNG','ABNB',
  'AMZN','EBAY','ETSY','DPZ','YUM','TSCO','RH','WSM','ULTA','ROST',
  // Consumer Staples
  'PG','KO','PEP','WMT','COST','PM','MO','CL','MDLZ','GIS',
  'KHC','SJM','CAG','HSY','MKC','CHD','CLX','KMB','EL','COTY',
  // Industrials
  'GE','HON','CAT','DE','RTX','LMT','NOC','GD','BA','TT',
  'EMR','PH','ETN','ITW','ROK','GWW','CTAS','PCAR','CMI','IR',
  'UNP','CSX','NSC','FDX','UPS','ODFL','JBHT','XPO','RXO',
  // Energy
  'XOM','CVX','COP','EOG','MPC','PSX','VLO','OXY','HES','DVN',
  'BKR','SLB','HAL','FANG','APA','MRO','PXD','CVI','DKS',
  // Materials
  'LIN','APD','ECL','NEM','FCX','NUE','VMC','MLM','CF','MOS',
  // Utilities
  'NEE','DUK','SO','AES','EXC','XEL','PCG','ED','WEC','DTE',
  // Real Estate
  'PLD','AMT','EQIX','WELL','DLR','PSA','EQR','AVB','O','CCI',
  // Communication Services
  'META','GOOGL','NFLX','DIS','CMCSA','T','VZ','CHTR','TMUS','DISH',
  // Growth / Recent
  'UBER','COIN','PLTR','APP','ARM','SMCI','CEG','VST','GEV','ABNB',
]

// Deduplicate
export const SP500 = [...new Set(SP500_TICKERS)]

// S&P 500 + NASDAQ representative ticker list
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
  'EBAY','ETSY','DPZ','YUM','TSCO','RH','WSM','ULTA','ROST',
  // Consumer Staples
  'PG','KO','PEP','WMT','PM','MO','CL','MDLZ','GIS',
  'KHC','SJM','CAG','HSY','MKC','CHD','CLX','KMB','EL','COTY',
  // Industrials
  'GE','HON','CAT','DE','RTX','LMT','NOC','GD','BA','TT',
  'EMR','PH','ETN','ITW','ROK','GWW','CTAS','PCAR','CMI','IR',
  'UNP','CSX','NSC','FDX','UPS','ODFL','JBHT','XPO','RXO',
  // Energy
  'XOM','CVX','COP','EOG','MPC','PSX','VLO','OXY','HES','DVN',
  'BKR','SLB','HAL','FANG','APA','MRO','CVI',
  // Materials
  'LIN','APD','ECL','NEM','FCX','NUE','VMC','MLM','CF','MOS',
  // Utilities
  'NEE','DUK','SO','AES','EXC','XEL','PCG','ED','WEC','DTE',
  // Real Estate
  'PLD','AMT','EQIX','WELL','DLR','PSA','EQR','AVB','O','CCI',
  // Communication Services
  'NFLX','DIS','CMCSA','T','VZ','CHTR','TMUS','DISH',
  // Growth / Recent additions
  'UBER','COIN','PLTR','APP','ARM','SMCI','CEG','VST','GEV',

  // --- NASDAQ 100 (not already above) ---
  'ASML','MELI','NXPI','MRVL','ON','SWKS','QRVO',
  'PAYX','FAST','KDP','CSGP','VRSK','ALGN','BIIB','ILMN','MRNA',
  'GEHC','SBAC','DLTR','SGEN','BMRN','EXAS','PODD','HOLX',
  'LULU','MNST','CPRT','ODFL',
  'PSTG','NTNX','ANET','HPE','DELL',

  // --- High-volume NASDAQ growth / fintech / EV ---
  'SQ','PYPL','SHOP','SE','NU','SOFI','HOOD','AFRM','UPST',
  'RIVN','LCID','NIO','LI','XPEV',
  'RBLX','DKNG','PENN','MGAM',
  'SNOW','CFLT','MNDY','GTLB','BILL','PATH','AI','ZI',
  'DOCN','ESTC','PD','FROG','S','SMAR',
  'IONQ','RGTI','QUBT','QBTS',
  'MSTR','RIOT','MARA','HUT','CLSK',

  // --- NASDAQ biotech / pharma ---
  'SAVA','SRPT','RARE','FOLD','ACAD','LEGN','KRYS','RCKT',
  'INSM','ARWR','BEAM','EDIT','NTLA','CRSP','VERV',
]

// Deduplicate
export const SP500 = [...new Set(SP500_TICKERS)]

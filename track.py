import asyncio
from solana.rpc.api import Client
from solana.rpc.websocket_api import connect
from solana.publickey import PublicKey

# Solana mainnet RPC endpoints
RPC_HTTP_URL = "https://api.mainnet-beta.solana.com"
RPC_WS_URL = "wss://api.mainnet-beta.solana.com"

# Wallet address to track (replace with your target)
WALLET_ADDRESS = "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj"

# Known DEX program IDs (Raydium, Orca, etc.)
DEX_PROGRAM_IDS = {
    "Raydium": "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX",
    "Orca": "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
}

def get_recent_transactions():
    """Fetch recent transactions for a wallet using HTTP API."""
    solana_client = Client(RPC_HTTP_URL)
    public_key = PublicKey(WALLET_ADDRESS)
    
    try:
        # Get last 10 transactions
        transactions = solana_client.get_confirmed_signatures_for_address2(
            public_key, limit=10
        )
        
        print(f"\n📜 Recent Transactions for {WALLET_ADDRESS}:")
        for tx in transactions.value:
            print(f"\n🔹 Signature: {tx.signature}")
            print(f"⏱️ Block Time: {tx.block_time}")
            print(f"✅ Status: {'Success' if not tx.err else 'Failed'}")
            
            # Optional: Fetch full transaction details
            # tx_details = solana_client.get_confirmed_transaction(tx.signature)
            # print(f"Details: {tx_details}")
            
    except Exception as e:
        print(f"❌ Error fetching transactions: {e}")

async def track_realtime_transactions():
    """Monitor real-time transactions using WebSocket."""
    public_key = PublicKey(WALLET_ADDRESS)
    
    async with connect(RPC_WS_URL) as websocket:
        # Subscribe to the wallet's transaction events
        await websocket.logs_subscribe(public_key)
        
        print(f"\n👂 Listening for real-time transactions for {WALLET_ADDRESS}...")
        async for response in websocket:
            # Parse the transaction log
            log = response.result.value.logs
            signature = response.result.value.signature
            
            # Check if it's a DEX trade
            for dex_name, program_id in DEX_PROGRAM_IDS.items():
                if program_id in str(log):
                    print(f"\n🚨 {dex_name} Trade Detected!")
                    print(f"🔹 Signature: {signature}")
                    print(f"📝 Logs: {log}")
                    break  # Stop checking other DEXs if matched

if __name__ == "__main__":
    print("🔍 Solana Wallet Tracker 🔍")
    
    # Fetch recent transactions (HTTP)
    get_recent_transactions()
    
    # Start real-time monitoring (WebSocket)
    try:
        asyncio.get_event_loop().run_until_complete(track_realtime_transactions())
    except KeyboardInterrupt:
        print("\n🛑 Stopped monitoring.")

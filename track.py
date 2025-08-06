import asyncio
from solana.rpc.api import Client
from solana.rpc.websocket_api import connect
from solana import PublicKey  # Updated import

# Solana mainnet RPC endpoints
RPC_HTTP_URL = "https://api.mainnet-beta.solana.com"
RPC_WS_URL = "wss://api.mainnet-beta.solana.com"

# Wallet address to track
WALLET_ADDRESS = "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj"

# Known DEX program IDs
DEX_PROGRAM_IDS = {
    "Raydium": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "Orca": "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
}

def get_recent_transactions():
    solana_client = Client(RPC_HTTP_URL)
    public_key = PublicKey(WALLET_ADDRESS)
    
    try:
        transactions = solana_client.get_signatures_for_address(
            public_key, limit=10
        )
        
        print(f"\n📜 Recent Transactions for {WALLET_ADDRESS}:")
        for tx in transactions.value:
            print(f"\n🔹 Signature: {tx.signature}")
            print(f"⏱️ Slot: {tx.slot}")
            print(f"✅ Status: {'Success' if not tx.err else 'Failed'}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

async def track_realtime_transactions():
    public_key = PublicKey(WALLET_ADDRESS)
    
    async with connect(RPC_WS_URL) as websocket:
        await websocket.logs_subscribe(public_key)
        
        print(f"\n👂 Listening for real-time transactions...")
        async for response in websocket:
            log = response.result.value.logs
            signature = response.result.value.signature
            
            for dex_name, program_id in DEX_PROGRAM_IDS.items():
                if program_id in str(log):
                    print(f"\n🚨 {dex_name} Trade Detected!")
                    print(f"🔹 Signature: {signature}")
                    break

if __name__ == "__main__":
    print("🔍 Solana Wallet Tracker 🔍")
    get_recent_transactions()
    
    try:
        asyncio.run(track_realtime_transactions())
    except KeyboardInterrupt:
        print("\n🛑 Stopped monitoring.")

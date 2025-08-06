import asyncio
from solana.rpc.api import Client
from solana.rpc.websocket_api import connect
from solana.publickey import PublicKey  # ✅ Corrected import

# Solana mainnet endpoints
RPC_HTTP_URL = "https://api.mainnet-beta.solana.com"
RPC_WS_URL = "wss://api.mainnet-beta.solana.com"

# Wallet to monitor
WALLET_ADDRESS = "DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj"

# DEX program IDs to detect
DEX_PROGRAM_IDS = {
    "Raydium": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "Orca": "9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP",
}


def get_recent_transactions():
    solana_client = Client(RPC_HTTP_URL)
    public_key = PublicKey(WALLET_ADDRESS)

    try:
        response = solana_client.get_signatures_for_address(public_key, limit=10)

        if response.get("result"):
            print(f"\n📜 Recent Transactions for {WALLET_ADDRESS}:")
            for tx in response["result"]:
                signature = tx.get("signature")
                slot = tx.get("slot")
                err = tx.get("err")

                print(f"\n🔹 Signature: {signature}")
                print(f"⏱️ Slot: {slot}")
                print(f"✅ Status: {'Success' if not err else 'Failed'}")
        else:
            print("⚠️ No transactions found or bad response format.")

    except Exception as e:
        print(f"❌ Error fetching transactions: {e}")


async def track_realtime_transactions():
    public_key = PublicKey(WALLET_ADDRESS)

    try:
        async with connect(RPC_WS_URL) as websocket:
            await websocket.logs_subscribe(public_key)
            print("\n👂 Listening for real-time transactions... (Press Ctrl+C to stop)")

            async for response in websocket:
                logs = response.result.value.logs
                signature = response.result.value.signature

                for dex_name, program_id in DEX_PROGRAM_IDS.items():
                    if program_id in str(logs):
                        print(f"\n🚨 {dex_name} Trade Detected!")
                        print(f"🔹 Signature: {signature}")
                        break
    except Exception as e:
        print(f"\n❌ WebSocket connection error: {e}")


if __name__ == "__main__":
    print("🔍 Solana Wallet Tracker 🔍")

    get_recent_transactions()

    try:
        asyncio.run(track_realtime_transactions())
    except KeyboardInterrupt:
        print("\n🛑 Stopped monitoring.")

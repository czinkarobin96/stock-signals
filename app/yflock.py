"""yf.download keeps shared module-level state, so concurrent downloads in one
process can overwrite each other's frames. Serialise them with one lock."""
import threading

lock = threading.Lock()

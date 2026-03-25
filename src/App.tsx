import { useState, useEffect, useCallback } from 'react';
import { 
  onAuthStateChanged, 
  signInWithPopup, 
  GoogleAuthProvider, 
  signOut, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc, 
  updateDoc,
  orderBy,
  getDocFromServer
} from 'firebase/firestore';
import { auth, db } from './lib/firebase';
import { TrackedItem, SaleResult, OperationType } from './types';
import { searchSales, SaleInfo } from './services/geminiService';
import { Search, Plus, Trash2, ExternalLink, MapPin, LogOut, Loader2, Tag, ShoppingBag, TrendingDown, RefreshCw, AlertCircle } from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { cn } from './lib/utils';
import { formatDistanceToNow } from 'date-fns';

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  toast.error(`Database error: ${errInfo.error}`);
  throw new Error(JSON.stringify(errInfo));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<TrackedItem[]>([]);
  const [results, setResults] = useState<Record<string, SaleResult[]>>({});
  const [newItemName, setNewItemName] = useState('');
  const [location, setLocation] = useState<string>('');
  const [searching, setSearching] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Geolocation
  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          // Simple reverse geocoding or just use coordinates
          setLocation(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
          
          // Try to get a more readable location if possible
          try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
            const data = await response.json();
            if (data.address) {
              const city = data.address.city || data.address.town || data.address.village || '';
              const state = data.address.state || '';
              setLocation(`${city}${city && state ? ', ' : ''}${state}`);
            }
          } catch (e) {
            console.error("Failed to reverse geocode location", e);
          }
        },
        (error) => {
          console.error("Error getting location", error);
          toast.error("Could not get your location. Please enter it manually.");
        }
      );
    }
  }, []);

  // Fetch items
  useEffect(() => {
    if (!user) {
      const localItems = localStorage.getItem('guest_items');
      if (localItems) {
        setItems(JSON.parse(localItems));
      } else {
        setItems([]);
      }
      return;
    }

    const q = query(
      collection(db, 'trackedItems'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const itemsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as TrackedItem));
      setItems(itemsData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'trackedItems');
    });

    return () => unsubscribe();
  }, [user]);

  // Fetch results for all items
  useEffect(() => {
    if (!user) {
      const localResults = localStorage.getItem('guest_results');
      if (localResults) {
        setResults(JSON.parse(localResults));
      } else {
        setResults({});
      }
      return;
    }

    if (items.length === 0) {
      setResults({});
      return;
    }

    const q = query(
      collection(db, 'saleResults'),
      where('userId', '==', user.uid),
      orderBy('foundAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const resultsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SaleResult));
      const groupedResults: Record<string, SaleResult[]> = {};
      
      resultsData.forEach(result => {
        if (!groupedResults[result.trackedItemId]) {
          groupedResults[result.trackedItemId] = [];
        }
        groupedResults[result.trackedItemId].push(result);
      });
      
      setResults(groupedResults);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'saleResults');
    });

    return () => unsubscribe();
  }, [user, items]);

  // Save to localStorage for guests
  useEffect(() => {
    if (!user) {
      localStorage.setItem('guest_items', JSON.stringify(items));
      localStorage.setItem('guest_results', JSON.stringify(results));
    }
  }, [items, results, user]);

  // Sync guest data to Firestore on login
  useEffect(() => {
    if (user) {
      const syncData = async () => {
        const localItems = localStorage.getItem('guest_items');
        const localResults = localStorage.getItem('guest_results');
        
        if (localItems) {
          try {
            const itemsToSync = JSON.parse(localItems) as TrackedItem[];
            if (itemsToSync.length > 0) {
              toast.info("Syncing your guest data to your account...");
              
              const resultsToSync = localResults ? JSON.parse(localResults) as Record<string, SaleResult[]> : {};
              
              for (const item of itemsToSync) {
                // Check if item already exists (simple name check)
                const exists = items.some(i => i.name.toLowerCase() === item.name.toLowerCase());
                if (!exists) {
                  const { id: oldId, ...itemData } = item;
                  const docRef = await addDoc(collection(db, 'trackedItems'), {
                    ...itemData,
                    userId: user.uid,
                    createdAt: new Date().toISOString()
                  });
                  
                  // Sync results for this item
                  const itemResults = resultsToSync[oldId];
                  if (itemResults) {
                    for (const result of itemResults) {
                      const { id: rid, ...resultData } = result;
                      await addDoc(collection(db, 'saleResults'), {
                        ...resultData,
                        trackedItemId: docRef.id,
                        userId: user.uid,
                        foundAt: new Date().toISOString()
                      });
                    }
                  }
                }
              }
              
              // Clear local storage after sync
              localStorage.removeItem('guest_items');
              localStorage.removeItem('guest_results');
              toast.success("Data synced successfully!");
            }
          } catch (e) {
            console.error("Failed to sync guest data", e);
          }
        }
      };
      
      syncData();
    }
  }, [user]);

  const [loggingIn, setLoggingIn] = useState(false);

  const login = async () => {
    setLoggingIn(true);
    try {
      const provider = new GoogleAuthProvider();
      // Force account selection to ensure the popup doesn't just flicker
      provider.setCustomParameters({ prompt: 'select_account' });
      
      const result = await signInWithPopup(auth, provider);
      if (result.user) {
        toast.success("Welcome back!");
      }
    } catch (error: any) {
      console.error("Login failed detail:", error);
      if (error.code === 'auth/popup-closed-by-user') {
        toast.error("Sign-in popup was closed before finishing.");
      } else if (error.code === 'auth/unauthorized-domain') {
        toast.error("This domain is not authorized for Firebase Auth. Please check your Firebase Console.");
      } else {
        toast.error(`Login failed: ${error.message || "Unknown error"}`);
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const logout = () => {
    signOut(auth);
    toast.success("Logged out successfully");
  };

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName.trim()) return;

    try {
      const itemData = {
        name: newItemName.trim(),
        createdAt: new Date().toISOString()
      };

      if (user) {
        await addDoc(collection(db, 'trackedItems'), {
          ...itemData,
          userId: user.uid,
        });
      } else {
        const newItem: TrackedItem = {
          id: crypto.randomUUID(),
          ...itemData,
          userId: 'guest'
        };
        setItems(prev => [newItem, ...prev]);
      }
      
      setNewItemName('');
      toast.success(`Started tracking ${newItemName}`);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'trackedItems');
    }
  };

  const [itemToDelete, setItemToDelete] = useState<{id: string, name: string} | null>(null);

  const deleteItem = async () => {
    if (!itemToDelete || deleting) return;
    const { id, name } = itemToDelete;
    setDeleting(id);
    try {
      if (user) {
        await deleteDoc(doc(db, 'trackedItems', id));
        // Also delete associated results
        const itemResults = results[id] || [];
        for (const result of itemResults) {
          try {
            await deleteDoc(doc(db, 'saleResults', result.id));
          } catch (e) {
            // Ignore individual result deletion errors (might be already deleted)
            console.warn(`Failed to delete result ${result.id}`, e);
          }
        }
      } else {
        setItems(prev => prev.filter(item => item.id !== id));
        setResults(prev => {
          const newResults = { ...prev };
          delete newResults[id];
          return newResults;
        });
      }
      toast.success(`Stopped tracking ${name}`);
      setItemToDelete(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'trackedItems');
    } finally {
      setDeleting(null);
    }
  };

  const findSales = async (item: TrackedItem) => {
    if (!location) {
      toast.error("Please provide your location first.");
      return;
    }

    setSearching(item.id);
    toast.info(`Searching for sales on ${item.name}...`);

    try {
      const sales = await searchSales(item.name, location);
      
      if (sales.length === 0) {
        toast.info(`No new sales found for ${item.name} right now.`);
      } else {
        if (user) {
          // Clear old results for this item first in parallel
          const oldResults = results[item.id] || [];
          const deletePromises = oldResults.map(old => 
            deleteDoc(doc(db, 'saleResults', old.id)).catch(e => {
              console.warn(`Failed to delete old result ${old.id}`, e);
            })
          );
          await Promise.all(deletePromises);

          // Save new results in parallel
          const addPromises = sales.map(sale => 
            addDoc(collection(db, 'saleResults'), {
              trackedItemId: item.id,
              userId: user.uid,
              storeName: sale.storeName,
              price: sale.price,
              originalPrice: sale.originalPrice || null,
              discount: sale.discount || null,
              url: sale.url,
              description: sale.description || null,
              foundAt: new Date().toISOString()
            })
          );
          await Promise.all(addPromises);
          
          // Update item's last search time
          await updateDoc(doc(db, 'trackedItems', item.id), {
            lastSearchAt: new Date().toISOString()
          });
        } else {
          const newResults: SaleResult[] = sales.map(sale => ({
            id: crypto.randomUUID(),
            trackedItemId: item.id,
            userId: 'guest',
            storeName: sale.storeName,
            price: sale.price,
            originalPrice: sale.originalPrice || null,
            discount: sale.discount || null,
            url: sale.url,
            description: sale.description || null,
            foundAt: new Date().toISOString()
          }));

          setResults(prev => ({
            ...prev,
            [item.id]: newResults
          }));

          setItems(prev => prev.map(i => i.id === item.id ? { ...i, lastSearchAt: new Date().toISOString() } : i));
        }

        toast.success(`Found ${sales.length} sales for ${item.name}!`);
      }
    } catch (error) {
      console.error("Search failed", error);
      toast.error("Failed to search for sales. Please try again.");
    } finally {
      setSearching(null);
    }
  };

  const getBestDealId = (itemResults: SaleResult[]) => {
    if (!itemResults || itemResults.length === 0) return null;
    
    let bestId = null;
    let maxSavingsPercent = 0;
    
    itemResults.forEach(result => {
      const current = parseFloat(result.price.replace(/[^0-9.]/g, '')) || 0;
      const original = result.originalPrice ? (parseFloat(result.originalPrice.replace(/[^0-9.]/g, '')) || current) : current;
      
      if (original > current && original > 0) {
        const savingsPercent = (original - current) / original;
        if (savingsPercent > maxSavingsPercent) {
          maxSavingsPercent = savingsPercent;
          bestId = result.id;
        }
      }
    });
    
    return bestId;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F8F9FA] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-gray-900 font-sans pb-20">
      <Toaster position="top-center" richColors />
      
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-bottom border-gray-100">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-xl tracking-tight">Deal Finder</span>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 bg-gray-100 px-3 py-1.5 rounded-full text-sm text-gray-600">
              <MapPin className="w-4 h-4 text-blue-500" />
              <input 
                type="text" 
                value={location} 
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Enter location..."
                className="bg-transparent border-none focus:ring-0 w-32 p-0 text-sm"
              />
            </div>
            
            {user ? (
              <div className="flex items-center gap-3">
                <img src={user.photoURL || ''} className="w-8 h-8 rounded-full border-2 border-blue-100" alt={user.displayName || ''} />
                <button 
                  onClick={logout}
                  className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-5 h-5" />
                </button>
              </div>
            ) : (
              <button 
                onClick={login}
                disabled={loggingIn}
                className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold py-2 px-4 rounded-xl transition-all flex items-center gap-2 shadow-md shadow-blue-100"
              >
                {loggingIn ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <img src="https://www.google.com/favicon.ico" className="w-4 h-4" alt="Google" />
                )}
                <span>{loggingIn ? "Signing in..." : "Sign In"}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 pt-8">
        {/* Add Item Form */}
        <section className="mb-12">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-4">Add New Item</h2>
          <form onSubmit={addItem} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input 
                type="text" 
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                placeholder="What are you looking for? (e.g. iPhone 15, Nike Shoes)"
                className="w-full bg-white border border-gray-200 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all shadow-sm"
              />
            </div>
            <button 
              type="submit"
              disabled={!newItemName.trim()}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white p-4 rounded-2xl transition-all shadow-lg shadow-blue-100"
            >
              <Plus className="w-6 h-6" />
            </button>
          </form>
          
          <div className="sm:hidden mt-4 flex items-center gap-2 bg-white border border-gray-200 px-4 py-3 rounded-2xl text-sm text-gray-600 shadow-sm">
            <MapPin className="w-4 h-4 text-blue-500" />
            <input 
              type="text" 
              value={location} 
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Enter location..."
              className="bg-transparent border-none focus:ring-0 flex-1 p-0 text-sm"
            />
          </div>
        </section>

        {/* Tracked Items List */}
        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Tracked Items</h2>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">{items.length} items</span>
          </div>

          {items.length === 0 ? (
            <div className="bg-white border border-dashed border-gray-300 rounded-3xl p-12 text-center">
              <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Tag className="w-8 h-8 text-gray-300" />
              </div>
              <p className="text-gray-500">You're not tracking any items yet. Add one above to start finding deals!</p>
            </div>
          ) : (
            <div className="space-y-6">
              {items.map((item) => (
                <div key={item.id} className="bg-white rounded-3xl border border-gray-100 shadow-sm overflow-hidden transition-all hover:shadow-md">
                  <div className="p-6 flex items-center justify-between border-b border-gray-50">
                    <div>
                      <h3 className="text-xl font-bold text-gray-900 mb-1">{item.name}</h3>
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        <span className="flex items-center gap-1">
                          <TrendingDown className="w-3 h-3" />
                          {results[item.id]?.length || 0} deals found
                        </span>
                        {item.lastSearchAt && (
                          <span className="flex items-center gap-1">
                            <RefreshCw className="w-3 h-3" />
                            Last checked {formatDistanceToNow(new Date(item.lastSearchAt))} ago
                          </span>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => findSales(item)}
                        disabled={searching === item.id}
                        className={cn(
                          "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all",
                          searching === item.id 
                            ? "bg-gray-100 text-gray-400" 
                            : "bg-blue-50 text-blue-600 hover:bg-blue-100"
                        )}
                      >
                        {searching === item.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Search className="w-4 h-4" />
                        )}
                        {searching === item.id ? 'Searching...' : 'Find Deals'}
                      </button>
                      <button 
                        onClick={() => setItemToDelete({id: item.id, name: item.name})}
                        className="p-2 text-gray-300 hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>

                  {/* Results Section */}
                  <div className="bg-gray-50/50 p-6">
                    {!results[item.id] || results[item.id].length === 0 ? (
                      <div className="text-center py-4">
                        <p className="text-sm text-gray-400 italic">No deals saved yet. Click "Find Deals" to search.</p>
                      </div>
                    ) : (() => {
                      const bestId = getBestDealId(results[item.id]);
                      return (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          {results[item.id].map((result) => (
                            <a 
                              key={result.id}
                              href={result.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(
                                "group bg-white p-4 rounded-2xl border transition-all flex flex-col justify-between relative",
                                result.id === bestId ? "border-blue-300 shadow-md ring-1 ring-blue-100" : "border-gray-100 shadow-sm hover:border-blue-200"
                              )}
                            >
                              {result.id === bestId && (
                                <div className="absolute -top-2 -right-2 bg-blue-600 text-white text-[10px] font-bold px-2 py-1 rounded-full shadow-lg z-10 animate-pulse">
                                  BEST VALUE
                                </div>
                              )}
                              <div>
                                <div className="flex items-start justify-between mb-2">
                                <span className="text-xs font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                                  {result.storeName}
                                </span>
                                <ExternalLink className="w-4 h-4 text-gray-300 group-hover:text-blue-400 transition-colors" />
                              </div>
                              <div className="flex items-baseline gap-2 mb-1">
                                <span className="text-lg font-bold text-gray-900">{result.price}</span>
                                {result.originalPrice && (
                                  <span className="text-sm text-gray-400 line-through">{result.originalPrice}</span>
                                )}
                              </div>
                              {result.discount && (
                                <div className="inline-flex items-center gap-1 text-xs font-bold text-green-600 mb-2">
                                  <TrendingDown className="w-3 h-3" />
                                  {result.discount} OFF
                                </div>
                              )}
                              {result.description && (
                                <p className="text-xs text-gray-500 line-clamp-2 mb-3">{result.description}</p>
                              )}
                            </div>
                            <div className="text-[10px] text-gray-300 mt-auto">
                              Found {formatDistanceToNow(new Date(result.foundAt))} ago
                            </div>
                          </a>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>

      {/* Delete Confirmation Modal */}
      {itemToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl">
            <h3 className="text-xl font-bold mb-2">Stop tracking?</h3>
            <p className="text-gray-500 mb-6">Are you sure you want to stop tracking "{itemToDelete.name}"? All saved deals for this item will be removed.</p>
            <div className="flex gap-3">
              <button 
                onClick={() => setItemToDelete(null)}
                className="flex-1 px-4 py-3 rounded-xl font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-all"
              >
                Cancel
              </button>
              <button 
                onClick={deleteItem}
                disabled={!!deleting}
                className="flex-1 px-4 py-3 rounded-xl font-semibold text-white bg-red-500 hover:bg-red-600 transition-all shadow-lg shadow-red-100 flex items-center justify-center gap-2"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                <span>{deleting ? "Deleting..." : "Stop Tracking"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer Info */}
      <footer className="max-w-4xl mx-auto px-4 mt-20 text-center text-gray-400 text-xs">
        <p>© 2026 SaleTracker • Powered by Gemini AI</p>
      </footer>
    </div>
  );
}

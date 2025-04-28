# neoshell/CMakeLists.txt
cmake_minimum_required(VERSION 3.10)
project(nsi-sandbox CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED True)

# Enable compiler warnings
if(CMAKE_COMPILER_IS_GNUCC OR CMAKE_COMPILER_IS_CLANG)
  add_compile_options(-Wall -Wextra -pedantic)
endif()

# --- Static Linking (Optional, but recommended for portability) ---
# Uncomment the next line if you want to try static linking (requires musl-gcc or similar setup)
# set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -static")
# --- End Static Linking ---


add_executable(nsi-sandbox src/sandbox/main.cpp)

# Add optimization for release builds
set_target_properties(nsi-sandbox PROPERTIES
    COMPILE_FLAGS_RELEASE "-O2 -DNDEBUG"
    LINK_FLAGS_RELEASE "-O2")

install(TARGETS nsi-sandbox DESTINATION bin) # Optional: for system install
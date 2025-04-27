# src/Makefile
CXX = g++
CXXFLAGS = -Wall -std=c++11
TARGET = ../bin/container_launcher # Place the binary in bin for Node access

all: $(TARGET)

$(TARGET): container_launcher.cpp
	@mkdir -p ../bin # Ensure bin directory exists
	$(CXX) $(CXXFLAGS) $< -o $@

clean:
	rm -f $(TARGET)

.PHONY: all clean